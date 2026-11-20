// src/shaders.js
// 所有 GLSL ES 3.00 着色器源码（WebGL2）。
//
// 管线概览：
//   1. ADVECT  : transform feedback 程序，开启 RASTERIZER_DISCARD，
//                读取粒子状态 -> 采样风场 -> RK2 平流 -> 写出新状态
//   2. FADE    : 全屏三角形，把上一帧拖尾纹理乘以衰减系数写入当前拖尾纹理
//   3. DRAW    : 实例化绘制线段（上一帧位置 -> 当前位置），按速度着色，叠加到拖尾纹理
//   4. SCREEN  : 全屏三角形，把拖尾纹理合成到画布（叠加背景色）
//
// 数据布局（与 particles.js 保持一致）：
//   a_state / v_state : vec4(pos.x, pos.y, age, life)      —— ping-pong 两个 buffer
//   v_trail / a_trail : vec4(prev.x, prev.y, speed, respawned) —— 一个 buffer，只写不读回平流
//   坐标为归一化场域 [0,1]²，y 向上；纹素中心在 (i + 0.5) / size。

export const INTERP_BILINEAR = 0;
export const INTERP_CUBIC = 1;

// transform feedback 输出的 varying 名称（SEPARATE_ATTRIBS 模式，顺序即绑定点 0、1）
export const ADVECT_VARYINGS = ["v_state", "v_trail"];

// ---------------------------------------------------------------------------
// 共享：风场采样函数（bilinear + Catmull-Rom cubic），均基于 texelFetch，
// 因此 RGBA32F 纹理不需要 OES_texture_float_linear 扩展。
// ---------------------------------------------------------------------------
const FIELD_SAMPLING_GLSL = `
uniform highp sampler2D u_field;
uniform ivec2 u_fieldSize;

// 读取单个纹素的 (u, v)，越界坐标钳制到边缘
vec2 fetchUV(ivec2 p) {
  p = clamp(p, ivec2(0), u_fieldSize - ivec2(1));
  return texelFetch(u_field, p, 0).rg;
}

// 双线性插值：4 次 texelFetch
vec2 sampleBilinear(vec2 uv) {
  vec2 st = uv * vec2(u_fieldSize) - 0.5;
  vec2 i = floor(st);
  vec2 f = st - i;
  ivec2 p = ivec2(i);

  vec2 a = fetchUV(p);
  vec2 b = fetchUV(p + ivec2(1, 0));
  vec2 c = fetchUV(p + ivec2(0, 1));
  vec2 d = fetchUV(p + ivec2(1, 1));

  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

// Catmull-Rom 权重，对应采样点 -1, 0, +1, +2
vec4 catmullRomWeights(float t) {
  float t2 = t * t;
  float t3 = t2 * t;
  return vec4(
    -0.5 * t3 +       t2 - 0.5 * t,
     1.5 * t3 - 2.5 * t2 + 1.0,
    -1.5 * t3 + 2.0 * t2 + 0.5 * t,
     0.5 * t3 - 0.5 * t2
  );
}

// 一行 4 个纹素按 x 方向权重加权
vec2 cubicRow(ivec2 p, int dy, vec4 wx) {
  return fetchUV(p + ivec2(-1, dy)) * wx.x
       + fetchUV(p + ivec2( 0, dy)) * wx.y
       + fetchUV(p + ivec2( 1, dy)) * wx.z
       + fetchUV(p + ivec2( 2, dy)) * wx.w;
}

// 双三次（Catmull-Rom）插值：16 次 texelFetch，未做任何优化
// 注意：Catmull-Rom 会产生过冲（overshoot），在梯度剧烈处可能略超出原始范围
vec2 sampleCubic(vec2 uv) {
  vec2 st = uv * vec2(u_fieldSize) - 0.5;
  vec2 i = floor(st);
  vec2 f = st - i;
  ivec2 p = ivec2(i);

  vec4 wx = catmullRomWeights(f.x);
  vec4 wy = catmullRomWeights(f.y);

  return cubicRow(p, -1, wx) * wy.x
       + cubicRow(p,  0, wx) * wy.y
       + cubicRow(p,  1, wx) * wy.z
       + cubicRow(p,  2, wx) * wy.w;
}
`;

// ---------------------------------------------------------------------------
// 1. 平流（transform feedback）
// ---------------------------------------------------------------------------
export const ADVECT_VS = `#version 300 es
precision highp float;
precision highp int;

layout(location = 0) in vec4 a_state; // xy = pos, z = age, w = life

uniform float u_dt;          // 帧间隔（秒）
uniform float u_speedScale;  // 场速度 -> 场域位移的缩放
uniform float u_seed;        // 每帧变化的随机种子
uniform float u_lifeMin;     // 重生寿命下限（秒）
uniform float u_lifeMax;     // 重生寿命上限（秒）
uniform float u_dropRate;    // 每帧随机重生概率，打散聚集
uniform int   u_interp;      // 0 = bilinear, 1 = cubic

out vec4 v_state;            // 新状态
out vec4 v_trail;            // xy = 上一帧位置, z = 风速大小, w = 本帧是否重生(1/0)

${FIELD_SAMPLING_GLSL}

vec2 sampleField(vec2 uv) {
  return (u_interp == 1) ? sampleCubic(uv) : sampleBilinear(uv);
}

// Dave Hoskins hash without sine
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  vec2  pos  = a_state.xy;
  float age  = a_state.z;
  float life = a_state.w;

  // RK2（中点法）积分
  float h = u_dt * u_speedScale;
  vec2 v1  = sampleField(pos);
  vec2 mid = pos + v1 * (0.5 * h);
  vec2 v2  = sampleField(mid);
  vec2 newPos = pos + v2 * h;
  float newAge = age + u_dt;

  float id = float(gl_VertexID);
  float rDrop = hash12(vec2(id * 0.917 + 1.0, u_seed));

  bool outOfBounds = any(lessThan(newPos, vec2(0.0))) || any(greaterThan(newPos, vec2(1.0)));
  bool expired     = newAge >= life;
  bool dropped     = rDrop < u_dropRate;

  if (outOfBounds || expired || dropped) {
    vec2 rp = vec2(
      hash12(vec2(id * 1.37 + 11.0, u_seed + 3.1)),
      hash12(vec2(id * 0.73 + 5.0,  u_seed + 7.7))
    );
    float rl = mix(u_lifeMin, u_lifeMax, hash12(vec2(id + 19.0, u_seed + 13.3)));
    v_state = vec4(rp, 0.0, rl);
    v_trail = vec4(rp, length(sampleField(rp)), 1.0);
  } else {
    v_state = vec4(newPos, newAge, life);
    v_trail = vec4(pos, length(v2), 0.0);
  }

  // RASTERIZER_DISCARD 下不会光栅化，但仍需写 gl_Position
  gl_Position = vec4(0.0);
  gl_PointSize = 1.0;
}
`;

// WebGL2 链接程序必须有片元着色器，即使开启了 RASTERIZER_DISCARD
export const ADVECT_FS = `#version 300 es
precision highp float;
out vec4 outColor;
void main() {
  outColor = vec4(0.0);
}
`;

// ---------------------------------------------------------------------------
// 2 & 4. 全屏三角形（无顶点 buffer，靠 gl_VertexID 生成）
// ---------------------------------------------------------------------------
export const QUAD_VS = `#version 300 es
precision highp float;
out vec2 v_uv;
void main() {
  // gl_VertexID = 0,1,2 -> (0,0), (2,0), (0,2)，覆盖整个屏幕
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  v_uv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

// 拖尾衰减：c * fade - bias。
// bias 用于克服 RGBA8 量化导致的“残影永不消失”（0.96 * 12/255 四舍五入仍为 12/255）
export const FADE_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_prev;
uniform float u_fade;
uniform float u_bias;
out vec4 outColor;
void main() {
  vec4 c = texture(u_prev, v_uv);
  outColor = max(c * u_fade - vec4(u_bias), vec4(0.0));
}
`;

// 合成到画布：拖尾纹理为预乘 alpha，叠加在背景色上
export const SCREEN_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_trail;
uniform vec3 u_background;
out vec4 outColor;
void main() {
  vec4 c = texture(u_trail, v_uv);
  outColor = vec4(u_background * (1.0 - c.a) + c.rgb, 1.0);
}
`;

// ---------------------------------------------------------------------------
// 3. 粒子渲染：每个粒子一个实例，2 个顶点组成线段（prev -> current）
// ---------------------------------------------------------------------------
export const DRAW_VS = `#version 300 es
precision highp float;

layout(location = 0) in vec4 a_state; // 每实例：xy = 当前位置, z = age, w = life
layout(location = 1) in vec4 a_trail; // 每实例：xy = 上一帧位置, z = speed, w = respawned

uniform float u_maxSpeed;

out float v_speed;  // 归一化速度 [0,1]
out float v_alpha;

void main() {
  // 本帧刚重生的粒子：把线段丢到裁剪空间外，避免画出跨屏长线
  if (a_trail.w > 0.5) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    v_speed = 0.0;
    v_alpha = 0.0;
    return;
  }

  vec2 p = (gl_VertexID == 0) ? a_trail.xy : a_state.xy;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);

  float s = clamp(a_trail.z / max(u_maxSpeed, 1e-5), 0.0, 1.0);
  v_speed = pow(s, 0.75); // 轻微提亮低速区域

  float age  = a_state.z;
  float life = a_state.w;
  // 出生淡入 + 临终淡出
  v_alpha = smoothstep(0.0, 0.4, age) * (1.0 - smoothstep(life * 0.8, life, age));
  // 线段尾端更暗，形成渐变
  v_alpha *= (gl_VertexID == 0) ? 0.35 : 1.0;
}
`;

export const DRAW_FS = `#version 300 es
precision highp float;

in float v_speed;
in float v_alpha;
out vec4 outColor;

// 速度色带：深蓝 -> 青 -> 绿 -> 黄 -> 红
vec3 speedRamp(float t) {
  const vec3 c0 = vec3(0.10, 0.20, 0.60);
  const vec3 c1 = vec3(0.00, 0.70, 0.90);
  const vec3 c2 = vec3(0.20, 0.90, 0.40);
  const vec3 c3 = vec3(1.00, 0.85, 0.20);
  const vec3 c4 = vec3(1.00, 0.25, 0.15);
  t = clamp(t, 0.0, 1.0) * 4.0;
  if (t < 1.0) return mix(c0, c1, t);
  if (t < 2.0) return mix(c1, c2, t - 1.0);
  if (t < 3.0) return mix(c2, c3, t - 2.0);
  return mix(c3, c4, t - 3.0);
}

void main() {
  vec3 c = speedRamp(v_speed);
  outColor = vec4(c * v_alpha, v_alpha); // 预乘 alpha，配合 blendFunc(ONE, ONE_MINUS_SRC_ALPHA)
}
`;
