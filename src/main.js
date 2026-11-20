// src/main.js
// 入口：初始化 WebGL2，串起风场纹理与粒子系统，驱动 requestAnimationFrame 循环，
// 处理画布 resize，并在左上角显示 FPS。
//
// 交互：
//   I  切换风场插值（bilinear / cubic）
//   R  重新撒点并清空拖尾

import { createFieldTexture } from "./field.js";
import { ParticleSystem } from "./particles.js";

const MAX_DPR = 2; // 限制设备像素比，避免高分屏上拖尾纹理过大
const FPS_UPDATE_INTERVAL = 500; // FPS 刷新间隔（毫秒）

const canvas = document.getElementById("gl");
const fpsEl = document.getElementById("fps");
const infoEl = document.getElementById("info");
const errorEl = document.getElementById("error");

function showError(message) {
  console.error(message);
  if (errorEl) {
    errorEl.style.display = "block";
    errorEl.textContent = message;
  }
}

function updateInfo(particles) {
  if (infoEl) {
    infoEl.textContent = `按 I 切换插值：${particles.interpolationName} | 按 R 重置 | N = ${particles.count}`;
  }
}

/**
 * 根据 CSS 尺寸和 DPR 同步画布像素尺寸，返回是否发生变化。
 */
function syncCanvasSize() {
  const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
  const w = Math.max(1, Math.floor(canvas.clientWidth * dpr));
  const h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    return true;
  }
  return false;
}

function main() {
  const gl = canvas.getContext("webgl2", {
    antialias: false,
    alpha: false,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: false,
    powerPreference: "high-performance",
  });

  if (!gl) {
    showError("当前浏览器不支持 WebGL2。\n请使用新版 Chrome / Edge / Firefox / Safari 15+。");
    return;
  }

  let field;
  let particles;
  try {
    field = createFieldTexture(gl);
    particles = new ParticleSystem(gl, field, { count: 5000 });
  } catch (err) {
    showError(`初始化失败：\n${err && err.message ? err.message : err}`);
    return;
  }

  syncCanvasSize();
  particles.resize(canvas.width, canvas.height);
  updateInfo(particles);

  // ---- resize：ResizeObserver 为主，window resize 兜底，每帧再校验一次 ----
  let needsResize = false;
  if (typeof ResizeObserver !== "undefined") {
    const ro = new ResizeObserver(() => {
      needsResize = true;
    });
    ro.observe(canvas);
  }
  window.addEventListener("resize", () => {
    needsResize = true;
  });

  // ---- 键盘交互 ----
  window.addEventListener("keydown", (e) => {
    if (e.repeat) return;
    const key = e.key.toLowerCase();
    if (key === "i") {
      particles.toggleInterpolation();
      updateInfo(particles);
    } else if (key === "r") {
      particles.reset();
    }
  });

  // ---- WebGL 上下文丢失处理 ----
  let running = true;
  let rafId = 0;
  canvas.addEventListener(
    "webglcontextlost",
    (e) => {
      e.preventDefault();
      running = false;
      cancelAnimationFrame(rafId);
      showError("WebGL 上下文丢失，正在尝试恢复……");
    },
    false
  );
  canvas.addEventListener(
    "webglcontextrestored",
    () => {
      // 最小 demo：直接重新加载页面重建所有 GPU 资源
      location.reload();
    },
    false
  );

  // ---- 主循环 ----
  let lastTime = performance.now();
  let fpsFrames = 0;
  let fpsLastTime = lastTime;

  function frame(now) {
    if (!running) return;

    const dt = (now - lastTime) / 1000;
    lastTime = now;

    if (syncCanvasSize() || needsResize) {
      needsResize = false;
      particles.resize(canvas.width, canvas.height);
    }

    particles.step(dt);
    particles.render();

    // FPS 统计
    fpsFrames++;
    const elapsed = now - fpsLastTime;
    if (elapsed >= FPS_UPDATE_INTERVAL) {
      const fps = (fpsFrames * 1000) / elapsed;
      if (fpsEl) {
        fpsEl.textContent = `FPS: ${fps.toFixed(1)}  (${canvas.width}×${canvas.height})`;
      }
      fpsFrames = 0;
      fpsLastTime = now;
    }

    rafId = requestAnimationFrame(frame);
  }

  rafId = requestAnimationFrame((t) => {
    lastTime = t;
    fpsLastTime = t;
    frame(t);
  });

  // 便于在控制台调试：__windDemo.particles.opts.speedScale = 0.2 等
  window.__windDemo = { gl, field, particles };
}

main();
