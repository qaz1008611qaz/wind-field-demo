// src/field.js
// 程序化生成二维风场（正弦叠加 + 一个 Lamb-Oseen 涡旋），
// 并把 u/v 分量编码进 RGBA32F 纹理：R = u, G = v, B = |V|, A = 1。
//
// 坐标约定（与 shaders.js 保持一致）：
//   - 场域为归一化坐标 [0,1] x [0,1]，x 向右，y 向上
//   - 纹素 (i, j) 的中心位于 ((i + 0.5) / W, (j + 0.5) / H)
//   - 纹理第 0 行对应 y ≈ 0（底部），与 WebGL 纹理坐标原点一致
//   - 速度单位：归一化场域单位 / 秒（量级约 0 ~ 2），渲染时再乘缩放系数

export const FIELD_SIZE = 256;

const TWO_PI = Math.PI * 2;

/**
 * 默认风场参数，可在 createFieldTexture 时部分覆盖。
 */
export const DEFAULT_FIELD_PARAMS = {
  width: FIELD_SIZE,
  height: FIELD_SIZE,
  // 背景平均流（整体向右偏）
  baseU: 0.25,
  baseV: 0.0,
  // 正弦叠加项：每一项 { ax, ay, kx, ky, phase }
  //   u += ax * sin(2π (kx*x + ky*y) + phase)
  //   v += ay * cos(2π (kx*x + ky*y) + phase)
  waves: [
    { ax: 0.5, ay: 0.0, kx: 0.0, ky: 1.0, phase: 0.0 },
    { ax: 0.0, ay: 0.35, kx: 1.5, ky: 0.0, phase: 0.4 },
    { ax: 0.3, ay: 0.3, kx: 3.0, ky: 2.0, phase: 1.3 },
    { ax: 0.15, ay: 0.2, kx: -2.0, ky: 3.0, phase: 0.7 },
  ],
  // 涡旋（Lamb-Oseen 模型，避免中心奇点）
  vortex: {
    cx: 0.62, // 中心 x
    cy: 0.45, // 中心 y
    strength: 0.2, // 环量系数，正值为逆时针
    coreRadius: 0.08, // 核半径，最大切向速度约出现在 1.12 * coreRadius 处
  },
};

/**
 * 解析计算任意点 (x, y) 处的风速，x/y 为归一化坐标。
 * 返回 [u, v]。
 */
export function evalField(x, y, params = DEFAULT_FIELD_PARAMS) {
  let u = params.baseU;
  let v = params.baseV;

  // 正弦叠加
  for (let k = 0; k < params.waves.length; k++) {
    const w = params.waves[k];
    const arg = TWO_PI * (w.kx * x + w.ky * y) + w.phase;
    u += w.ax * Math.sin(arg);
    v += w.ay * Math.cos(arg);
  }

  // 涡旋：切向速度 vθ = (Γ / r) * (1 - exp(-r² / rc²))
  // 写成向量形式：(u, v) += Γ * (1 - exp(-r²/rc²)) / r² * (-dy, dx)
  const vt = params.vortex;
  if (vt && vt.strength !== 0) {
    const dx = x - vt.cx;
    const dy = y - vt.cy;
    const r2 = dx * dx + dy * dy;
    const rc2 = vt.coreRadius * vt.coreRadius;
    const factor =
      r2 > 1e-12 ? (vt.strength * (1.0 - Math.exp(-r2 / rc2))) / r2 : 0.0;
    u += -dy * factor;
    v += dx * factor;
  }

  return [u, v];
}

/**
 * 在 CPU 上生成 RGBA float 数据。
 * 返回 { data: Float32Array, width, height, maxSpeed }。
 */
export function generateFieldData(params = DEFAULT_FIELD_PARAMS) {
  const W = params.width;
  const H = params.height;
  const data = new Float32Array(W * H * 4);
  let maxSpeed = 0;

  for (let j = 0; j < H; j++) {
    const y = (j + 0.5) / H;
    for (let i = 0; i < W; i++) {
      const x = (i + 0.5) / W;
      const [u, v] = evalField(x, y, params);
      const speed = Math.hypot(u, v);
      if (speed > maxSpeed) maxSpeed = speed;

      const idx = (j * W + i) * 4;
      data[idx + 0] = u; // R = u
      data[idx + 1] = v; // G = v
      data[idx + 2] = speed; // B = |V|（调试 / 着色备用）
      data[idx + 3] = 1.0; // A
    }
  }

  return { data, width: W, height: H, maxSpeed };
}

/**
 * 创建 RGBA32F 风场纹理。
 *
 * 注意：RGBA32F 的 LINEAR 过滤需要 OES_texture_float_linear 扩展，
 * 这里统一使用 NEAREST，插值交给 shader 里手写的 bilinear / cubic
 * （通过 texelFetch 读取），因此不依赖任何扩展。
 *
 * @param {WebGL2RenderingContext} gl
 * @param {object} [overrides] 覆盖 DEFAULT_FIELD_PARAMS 的部分字段
 * @returns {{ texture: WebGLTexture, width: number, height: number,
 *             maxSpeed: number, data: Float32Array, params: object,
 *             dispose: () => void }}
 */
export function createFieldTexture(gl, overrides = {}) {
  const params = {
    ...DEFAULT_FIELD_PARAMS,
    ...overrides,
    vortex: { ...DEFAULT_FIELD_PARAMS.vortex, ...(overrides.vortex || {}) },
    waves: overrides.waves || DEFAULT_FIELD_PARAMS.waves,
  };

  const { data, width, height, maxSpeed } = generateFieldData(params);

  const texture = gl.createTexture();
  if (!texture) {
    throw new Error("createFieldTexture: 无法创建纹理");
  }

  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA32F, // internalFormat
    width,
    height,
    0,
    gl.RGBA, // format
    gl.FLOAT, // type
    data
  );

  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  gl.bindTexture(gl.TEXTURE_2D, null);

  return {
    texture,
    width,
    height,
    maxSpeed,
    data,
    params,
    dispose() {
      gl.deleteTexture(texture);
    },
  };
}
