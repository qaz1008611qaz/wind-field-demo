# WebGL2 风场粒子 Demo

一个最小可运行的 GPU 风场粒子示例：纯原生 JavaScript + WebGL2，**无构建工具、无第三方库**。
5000 个粒子在程序化生成的风场中流动，用 transform feedback 在 GPU 上做平流，带拖尾和按速度着色。

---

## 运行

ES Module 不能通过 `file://` 加载（浏览器会以 CORS 理由拦截），需要起一个本地静态服务器。
在项目根目录（`index.html` 所在目录）执行以下任意一种：

```bash
# Python 3
python3 -m http.server 8000

# Node.js（无需安装，npx 临时拉取）
npx serve .

# PHP
php -S localhost:8000
```

然后浏览器打开 <http://localhost:8000>。

也可以用 VS Code 的 Live Server 插件直接打开 `index.html`。

### 浏览器要求

需要 WebGL2：Chrome / Edge 56+、Firefox 51+、Safari 15+。
不需要任何 WebGL 扩展（float 纹理只做 `texelFetch` 读取，不依赖 `OES_texture_float_linear`
或 `EXT_color_buffer_float`）。

### 交互

| 按键 | 作用 |
| ---- | ---- |
| `I`  | 切换风场插值：bilinear ↔ cubic（Catmull-Rom） |
| `R`  | 重新随机撒点并清空拖尾 |

控制台可通过 `window.__windDemo` 实时调参，例如：

```js
__windDemo.particles.opts.speedScale = 0.2;  // 流速
__windDemo.particles.opts.fade = 0.98;       // 拖尾更长
__windDemo.particles.opts.dropRate = 0.01;   // 更频繁地随机重生
```

---

## 目录结构

```
.
├── index.html          全屏 canvas、标题、FPS / 提示 HUD，加载 src/main.js（type=module）
├── README.md
└── src
    ├── main.js         入口：WebGL2 初始化、rAF 主循环、resize、FPS、键盘交互
    ├── field.js        程序化风场（正弦叠加 + Lamb-Oseen 涡旋）-> 256×256 RGBA32F 纹理
    ├── shaders.js      全部 GLSL ES 3.00 源码（平流 / 拖尾衰减 / 粒子线段 / 合成）
    └── particles.js    粒子系统：buffer、VAO、transform feedback、拖尾 ping-pong
```

---

## 架构

### 坐标与数据约定

- 场域是归一化坐标 `[0,1]²`，x 向右、y 向上，直接映射到整个画布（裁剪空间 `p * 2 - 1`）。
- 纹素 `(i, j)` 的中心位于 `((i + 0.5) / W, (j + 0.5) / H)`，shader 采样时用 `uv * size - 0.5` 对齐。
- 速度单位：归一化场域单位 / 秒，再乘 `speedScale`（默认 0.12）得到实际位移。

### 风场纹理（field.js）

| 通道 | 内容 |
| ---- | ---- |
| R    | u（x 分量） |
| G    | v（y 分量） |
| B    | \|V\|（速度大小，调试 / 备用） |
| A    | 1.0 |

风场 = 背景平均流 + 4 组正弦项 + 1 个 Lamb-Oseen 涡旋
（`vθ ∝ (1 − exp(−r²/rc²)) / r`，中心无奇点）。
CPU 端一次性生成后用 `texImage2D(RGBA32F, FLOAT)` 上传，过滤方式为 `NEAREST`，
插值全部在 shader 里手写。

### 粒子状态（particles.js）

| Buffer | 布局 | 用途 |
| ------ | ---- | ---- |
| `stateBuffers[0/1]` | `vec4(x, y, age, life)` | ping-pong：一个读、一个由 TF 写 |
| `trailBuffer` | `vec4(prevX, prevY, speed, respawned)` | TF 写出，仅供渲染读取 |

### 每帧管线

```
            ┌───────────────────────── step(dt) ─────────────────────────┐
            │  ADVECT（RASTERIZER_DISCARD + transform feedback）          │
 state[r] ──┤   采样风场（bilinear / cubic） → RK2 中点法积分             ├──> state[w]
            │   越界 / age ≥ life / 随机丢弃 → 重生（hash 随机位置与寿命）├──> trail
            └────────────────────────────────────────────────────────────┘
            ┌───────────────────────── render() ─────────────────────────┐
            │  FADE    trailTex[r] × fade − bias        → trailTex[w]      │
            │  DRAW    实例化 LINES：prev → current，按速度色带着色        │
            │          预乘 alpha，blend(ONE, ONE_MINUS_SRC_ALPHA) → trailTex[w] │
            │  SCREEN  trailTex[w] 叠加背景色             → 默认 framebuffer │
            └────────────────────────────────────────────────────────────┘
            交换 state 与 trailTex 的读写索引
```

要点：

- **transform feedback**：`SEPARATE_ATTRIBS` 模式，`v_state` → 绑定点 0，`v_trail` → 绑定点 1。
  平流前绑定输出 buffer，结束后立即解绑，避免同一 buffer 在渲染阶段同时作为 TF 输出和顶点输入。
- **随机数**：shader 中用无三角函数的 hash（`hash12`），种子为 `gl_VertexID` + 每帧 `u_seed`。
- **拖尾**：每个粒子一个实例、两个顶点（`gl_VertexID` 0 = 上一帧位置，1 = 当前位置），
  叠加到逐帧衰减的拖尾纹理上；刚重生的粒子被丢到裁剪空间外，不画跨屏长线。
- **全屏 pass**：无顶点 buffer，靠 `gl_VertexID` 生成覆盖全屏的单个三角形。
- **纹理单元**：风场固定用 `TEXTURE1`，拖尾用 `TEXTURE0`，不会出现读写同一纹理的反馈环。

### 可调参数（`DEFAULT_PARTICLE_OPTIONS`）

| 参数 | 默认值 | 说明 |
| ---- | ------ | ---- |
| `count` | 5000 | 粒子数 N |
| `speedScale` | 0.12 | 场速度 → 场域位移缩放 |
| `lifeMin` / `lifeMax` | 2 / 6 s | 重生时的随机寿命区间 |
| `dropRate` | 0.002 | 每帧随机重生概率 |
| `fade` | 0.96 | 拖尾每帧乘性衰减 |
| `fadeBias` | 1/255 | 拖尾每帧减性衰减，消除 8 位量化残影 |
| `background` | `[0.02, 0.027, 0.05]` | 背景色 |
| `interpolation` | bilinear | 初始插值方式 |
| `maxDt` | 1/20 s | 单帧 dt 上限 |

---

## 已知局限

### 1. RGBA 分量插值在场变化剧烈处有伪影

风场以 u、v 两个**独立分量**存入 RGBA32F 纹理并分别插值，这在以下区域会出问题：

- **涡旋核附近**：速度方向在一两个纹素内旋转很大角度，分别插值 u 和 v 会让插值结果的
  **模长被低估**（两个方向相反的向量插值后接近 0），方向也会偏离真实切向。
  表现为涡心附近粒子"卡顿"、轨迹出现折角或多边形化的环。
- **分辨率不足**：256×256 网格下，涡旋核半径 0.08 只覆盖约 20 个纹素，最大切向速度所在环带
  梯度很陡，bilinear 的 C⁰ 连续性会在纹素边界产生可见的速度跳变（轨迹上的细小折线）。
- **边界**：`CLAMP_TO_EDGE` 语义下最外一圈纹素会被重复使用，边缘处梯度被人为压平。
- **散度不为零**：正弦叠加场不是无散场，粒子会在汇聚区堆积，目前只靠寿命 + `dropRate` 打散。

可能的改进方向：提高纹理分辨率或局部加密；改存极坐标（模长 + 角度）并对角度做环绕插值；
对涡旋等解析已知的部分在 shader 里直接解析计算，纹理只存平滑的残差场；改用流函数 ψ 存储，
采样时取旋度得到无散速度。

### 2. cubic 插值待优化

`sampleCubic` 是直接写法的 Catmull-Rom 双三次插值：

- **16 次 `texelFetch`**，且平流采用 RK2，每个粒子每帧采样 2 次、共 32 次读取，
  是 bilinear 的 4 倍。粒子数提高到几十万时会成为瓶颈。
- **可优化**：利用硬件双线性把 16 次读取降到 9 次（Catmull-Rom）或 4 次（B-spline），
  但这需要 `LINEAR` 过滤，对 RGBA32F 必须开启 `OES_texture_float_linear`
  （部分移动端不支持），或者把场降为 RGBA16F。
- **过冲**：Catmull-Rom 不保持单调性，在梯度剧烈处会超出原始数据范围（overshoot），
  局部可能出现比真实值更大的速度。可以换成单调三次插值，或对结果按邻域 min/max 钳制。
- **分支**：插值方式由 uniform 选择，所有线程走同一分支，不会发散，但两套采样代码都会编译进同一个 shader。

### 3. 其它

- **线宽固定 1px**：WebGL 的 `lineWidth` 实际只支持 1，高分屏上拖尾偏细；
  更粗的线需要改为实例化 quad 自行展开。
- **慢速粒子不可见**：单帧位移不足 1 像素的线段可能不被光栅化，低速区靠拖尾累积才显现。
- **RGBA8 拖尾**：`fadeBias` 用减性衰减规避量化残影，代价是低亮度尾部消失得比纯指数衰减更快；
  不同 GPU 的 UNORM 舍入方式可能略有差异。
- **非正方形画布**：场域 `[0,1]²` 被拉伸到整个画布，宽屏上场在 x 方向被拉长、视觉速度各向异性。
- **静态风场**：风场只在启动时生成一次，没有随时间演化；要做动态场需每帧或定期更新纹理。
- **帧率相关**：`dropRate` 按"每帧"计，重生频率随帧率变化；dt 被钳制在 1/20 s 以内。
- **上下文丢失**：`webglcontextrestored` 时直接刷新页面，没有做 GPU 资源重建。
