// src/particles.js
// 粒子系统：N 个粒子，GPU transform feedback 平流，越界 / 寿命结束 / 随机丢弃时重生。
// 渲染流程（每帧）：
//   step(dt)  : ADVECT  —— stateBuffers[read] -> stateBuffers[write] + trailBuffer
//   render()  : FADE    —— trailTex[read] * fade -> trailTex[write]
//               DRAW    —— 线段 (prev -> current) 叠加到 trailTex[write]
//               SCREEN  —— trailTex[write] 合成到画布
//
// 依赖 shaders.js 中约定的数据布局：
//   state : vec4(pos.x, pos.y, age, life)
//   trail : vec4(prev.x, prev.y, speed, respawned)

import {
  ADVECT_VS,
  ADVECT_FS,
  ADVECT_VARYINGS,
  DRAW_VS,
  DRAW_FS,
  QUAD_VS,
  FADE_FS,
  SCREEN_FS,
  INTERP_BILINEAR,
  INTERP_CUBIC,
} from "./shaders.js";

export const DEFAULT_PARTICLE_OPTIONS = {
  count: 5000, // 粒子数 N
  speedScale: 0.12, // 场速度 -> 每秒场域位移
  lifeMin: 2.0, // 寿命下限（秒）
  lifeMax: 6.0, // 寿命上限（秒）
  dropRate: 0.002, // 每帧随机重生概率
  fade: 0.96, // 拖尾每帧衰减系数
  fadeBias: 1.0 / 255.0, // 拖尾每帧额外减去的量，清除 RGBA8 量化残影
  background: [0.02, 0.027, 0.05], // 背景色（与页面 #05070d 接近）
  interpolation: INTERP_BILINEAR, // 初始插值方式
  maxDt: 1 / 20, // dt 上限，防止切后台回来后一步跳太远
};

// ---------------------------------------------------------------------------
// GL 工具函数
// ---------------------------------------------------------------------------

export function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    const kind = type === gl.VERTEX_SHADER ? "vertex" : "fragment";
    const numbered = source
      .split("\n")
      .map((line, i) => `${String(i + 1).padStart(4, " ")}: ${line}`)
      .join("\n");
    throw new Error(`${kind} shader 编译失败:\n${log}\n----\n${numbered}`);
  }
  return shader;
}

/**
 * 创建并链接程序。tfVaryings 非空时设置 transform feedback 输出（SEPARATE_ATTRIBS）。
 */
export function createProgram(gl, vsSource, fsSource, tfVaryings = null) {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsSource);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSource);
  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  if (tfVaryings && tfVaryings.length > 0) {
    gl.transformFeedbackVaryings(program, tfVaryings, gl.SEPARATE_ATTRIBS);
  }
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`program 链接失败:\n${log}`);
  }
  return program;
}

function getUniforms(gl, program, names) {
  const out = {};
  for (const name of names) {
    // 被编译器优化掉的 uniform 会返回 null，对 null 调用 uniform* 是无操作，安全
    out[name] = gl.getUniformLocation(program, name);
  }
  return out;
}

// ---------------------------------------------------------------------------
// ParticleSystem
// ---------------------------------------------------------------------------

export class ParticleSystem {
  /**
   * @param {WebGL2RenderingContext} gl
   * @param {{texture: WebGLTexture, width: number, height: number, maxSpeed: number}} field
   * @param {Partial<typeof DEFAULT_PARTICLE_OPTIONS>} [options]
   */
  constructor(gl, field, options = {}) {
    this.gl = gl;
    this.field = field;
    this.opts = { ...DEFAULT_PARTICLE_OPTIONS, ...options };
    this.count = this.opts.count;
    this.interpolation = this.opts.interpolation;

    this.width = 0;
    this.height = 0;

    this._read = 0; // 当前有效的 state buffer 索引
    this._trailRead = 0; // 当前有效的拖尾纹理索引

    this.trailTextures = [null, null];
    this.trailFramebuffers = [null, null];

    this._initPrograms();
    this._initBuffers();
    this._initVAOs();

    this.tf = gl.createTransformFeedback();
  }

  // ---- 初始化 ---------------------------------------------------------------

  _initPrograms() {
    const gl = this.gl;

    const advect = createProgram(gl, ADVECT_VS, ADVECT_FS, ADVECT_VARYINGS);
    this.advect = {
      program: advect,
      u: getUniforms(gl, advect, [
        "u_field",
        "u_fieldSize",
        "u_dt",
        "u_speedScale",
        "u_seed",
        "u_lifeMin",
        "u_lifeMax",
        "u_dropRate",
        "u_interp",
      ]),
    };

    const draw = createProgram(gl, DRAW_VS, DRAW_FS);
    this.draw = {
      program: draw,
      u: getUniforms(gl, draw, ["u_maxSpeed"]),
    };

    const fade = createProgram(gl, QUAD_VS, FADE_FS);
    this.fade = {
      program: fade,
      u: getUniforms(gl, fade, ["u_prev", "u_fade", "u_bias"]),
    };

    const screen = createProgram(gl, QUAD_VS, SCREEN_FS);
    this.screen = {
      program: screen,
      u: getUniforms(gl, screen, ["u_trail", "u_background"]),
    };
  }

  _makeInitialData() {
    const N = this.count;
    const { lifeMin, lifeMax } = this.opts;
    const state = new Float32Array(N * 4);
    const trail = new Float32Array(N * 4);

    for (let i = 0; i < N; i++) {
      const x = Math.random();
      const y = Math.random();
      const life = lifeMin + (lifeMax - lifeMin) * Math.random();
      const age = Math.random() * life; // 年龄错开，避免同时重生

      state[i * 4 + 0] = x;
      state[i * 4 + 1] = y;
      state[i * 4 + 2] = age;
      state[i * 4 + 3] = life;

      trail[i * 4 + 0] = x;
      trail[i * 4 + 1] = y;
      trail[i * 4 + 2] = 0.0;
      trail[i * 4 + 3] = 1.0; // 标记为“刚重生”，首帧不画线段
    }
    return { state, trail };
  }

  _initBuffers() {
    const gl = this.gl;
    const { state, trail } = this._makeInitialData();

    this.stateBuffers = [gl.createBuffer(), gl.createBuffer()];
    for (const buf of this.stateBuffers) {
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, state, gl.DYNAMIC_COPY);
    }

    this.trailBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.trailBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, trail, gl.DYNAMIC_COPY);

    // 一个 divisor = 0 的占位属性：保证实例化绘制时至少有一个非实例属性，
    // 兼容对“全部属性都是实例属性”有限制的实现
    this.dummyBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.dummyBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 1]), gl.STATIC_DRAW);

    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }

  _initVAOs() {
    const gl = this.gl;

    // 平流 VAO：只读取 state buffer（location 0）
    this.advectVAOs = [0, 1].map((i) => {
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.stateBuffers[i]);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 0, 0);
      gl.bindVertexArray(null);
      return vao;
    });

    // 渲染 VAO：state（loc 0, 实例）+ trail（loc 1, 实例）+ dummy（loc 2, 顶点）
    this.drawVAOs = [0, 1].map((i) => {
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);

      gl.bindBuffer(gl.ARRAY_BUFFER, this.stateBuffers[i]);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 0, 0);
      gl.vertexAttribDivisor(0, 1);

      gl.bindBuffer(gl.ARRAY_BUFFER, this.trailBuffer);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 0, 0);
      gl.vertexAttribDivisor(1, 1);

      gl.bindBuffer(gl.ARRAY_BUFFER, this.dummyBuffer);
      gl.enableVertexAttribArray(2);
      gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 0, 0);
      gl.vertexAttribDivisor(2, 0);

      gl.bindVertexArray(null);
      return vao;
    });

    // 全屏三角形：无属性，靠 gl_VertexID
    this.quadVAO = gl.createVertexArray();

    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }

  // ---- 拖尾纹理 -------------------------------------------------------------

  _destroyTrails() {
    const gl = this.gl;
    for (let i = 0; i < 2; i++) {
      if (this.trailFramebuffers[i]) gl.deleteFramebuffer(this.trailFramebuffers[i]);
      if (this.trailTextures[i]) gl.deleteTexture(this.trailTextures[i]);
      this.trailFramebuffers[i] = null;
      this.trailTextures[i] = null;
    }
  }

  /**
   * 按画布像素尺寸（重新）创建两张 RGBA8 拖尾纹理。
   */
  resize(width, height) {
    width = Math.max(1, Math.floor(width));
    height = Math.max(1, Math.floor(height));
    if (width === this.width && height === this.height && this.trailTextures[0]) return;

    const gl = this.gl;
    this._destroyTrails();
    this.width = width;
    this.height = height;

    for (let i = 0; i < 2; i++) {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, width, height);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);

      const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      if (status !== gl.FRAMEBUFFER_COMPLETE) {
        throw new Error(`拖尾 framebuffer 不完整: 0x${status.toString(16)}`);
      }

      this.trailTextures[i] = tex;
      this.trailFramebuffers[i] = fbo;
    }

    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.clearTrails();
  }

  clearTrails() {
    const gl = this.gl;
    for (let i = 0; i < 2; i++) {
      if (!this.trailFramebuffers[i]) continue;
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.trailFramebuffers[i]);
      gl.viewport(0, 0, this.width, this.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  // ---- 插值方式 -------------------------------------------------------------

  setInterpolation(mode) {
    this.interpolation = mode === INTERP_CUBIC ? INTERP_CUBIC : INTERP_BILINEAR;
  }

  toggleInterpolation() {
    this.setInterpolation(
      this.interpolation === INTERP_CUBIC ? INTERP_BILINEAR : INTERP_CUBIC
    );
    return this.interpolation;
  }

  get interpolationName() {
    return this.interpolation === INTERP_CUBIC ? "cubic" : "bilinear";
  }

  // ---- 每帧更新 -------------------------------------------------------------

  /**
   * GPU 平流一步。
   * @param {number} dt 秒
   */
  step(dt) {
    dt = Math.min(Math.max(dt, 0), this.opts.maxDt);
    if (dt <= 0) return;

    const gl = this.gl;
    const { program, u } = this.advect;
    const read = this._read;
    const write = 1 - read;

    gl.useProgram(program);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.field.texture);
    gl.uniform1i(u.u_field, 1);
    gl.uniform2i(u.u_fieldSize, this.field.width, this.field.height);

    gl.uniform1f(u.u_dt, dt);
    gl.uniform1f(u.u_speedScale, this.opts.speedScale);
    gl.uniform1f(u.u_seed, Math.random() * 1000.0);
    gl.uniform1f(u.u_lifeMin, this.opts.lifeMin);
    gl.uniform1f(u.u_lifeMax, this.opts.lifeMax);
    gl.uniform1f(u.u_dropRate, this.opts.dropRate);
    gl.uniform1i(u.u_interp, this.interpolation);

    gl.bindVertexArray(this.advectVAOs[read]);
    gl.enable(gl.RASTERIZER_DISCARD);

    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, this.tf);
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, this.stateBuffers[write]);
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 1, this.trailBuffer);

    gl.beginTransformFeedback(gl.POINTS);
    gl.drawArrays(gl.POINTS, 0, this.count);
    gl.endTransformFeedback();

    // 立即解绑，避免这些 buffer 在渲染阶段同时作为 TF 输出和顶点输入
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, null);
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 1, null);
    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null);

    gl.disable(gl.RASTERIZER_DISCARD);
    gl.bindVertexArray(null);

    this._read = write;
  }

  /**
   * 渲染拖尾 + 粒子，并合成到当前画布（默认 framebuffer）。
   */
  render() {
    if (!this.trailTextures[0]) return;

    const gl = this.gl;
    const read = this._trailRead;
    const write = 1 - read;

    // 1) FADE：trailTex[read] * fade -> trailTex[write]
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.trailFramebuffers[write]);
    gl.viewport(0, 0, this.width, this.height);
    gl.disable(gl.BLEND);

    gl.useProgram(this.fade.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.trailTextures[read]);
    gl.uniform1i(this.fade.u.u_prev, 0);
    gl.uniform1f(this.fade.u.u_fade, this.opts.fade);
    gl.uniform1f(this.fade.u.u_bias, this.opts.fadeBias);

    gl.bindVertexArray(this.quadVAO);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // 2) DRAW：线段叠加到 trailTex[write]（预乘 alpha）
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    gl.useProgram(this.draw.program);
    gl.uniform1f(this.draw.u.u_maxSpeed, this.field.maxSpeed * 0.8);

    gl.bindVertexArray(this.drawVAOs[this._read]);
    gl.drawArraysInstanced(gl.LINES, 0, 2, this.count);

    gl.disable(gl.BLEND);

    // 3) SCREEN：trailTex[write] -> 画布
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);

    gl.useProgram(this.screen.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.trailTextures[write]);
    gl.uniform1i(this.screen.u.u_trail, 0);
    gl.uniform3fv(this.screen.u.u_background, this.opts.background);

    gl.bindVertexArray(this.quadVAO);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.bindVertexArray(null);
    this._trailRead = write;
  }

  // ---- 重置与释放 -----------------------------------------------------------

  /**
   * 重新随机撒点并清空拖尾。
   */
  reset() {
    const gl = this.gl;
    const { state, trail } = this._makeInitialData();
    for (const buf of this.stateBuffers) {
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, state);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.trailBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, trail);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    this.clearTrails();
  }

  dispose() {
    const gl = this.gl;
    this._destroyTrails();
    for (const vao of this.advectVAOs) gl.deleteVertexArray(vao);
    for (const vao of this.drawVAOs) gl.deleteVertexArray(vao);
    gl.deleteVertexArray(this.quadVAO);
    for (const buf of this.stateBuffers) gl.deleteBuffer(buf);
    gl.deleteBuffer(this.trailBuffer);
    gl.deleteBuffer(this.dummyBuffer);
    gl.deleteTransformFeedback(this.tf);
    gl.deleteProgram(this.advect.program);
    gl.deleteProgram(this.draw.program);
    gl.deleteProgram(this.fade.program);
    gl.deleteProgram(this.screen.program);
  }
}
