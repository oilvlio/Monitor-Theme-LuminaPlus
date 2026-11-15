import { useEffect, useRef, useState } from "react";
import type { PondInstance } from "@/vendor/ascii-pond/pond.js";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { usePreferences } from "@/hooks/usePreferences";
import { useSaveDataPreference } from "@/hooks/useSaveDataPreference";
import { useThemeSettings } from "@/hooks/useThemeSettings";
import { MOBILE_VIEWPORT_QUERY, REDUCED_MOTION_QUERY } from "@/utils/mediaQuery";

/**
 * 锦鲤水塘背景:复用 monitor-ascii-pond 的 ASCII 引擎,把锦鲤画成字形瓦片,游在
 * body::before 的背景图/纯色之上、卡片内容之下。引擎自己监听窗口点击来投喂
 * (按钮/输入框等交互元素会被忽略),所以 canvas 保持 pointer-events:none 即可。
 * 与桌面视频不同,移动端也渲染:引擎自带降载(更少的鱼、更低的帧率与 DPR)。
 */
export function PondBackgroundLayer() {
  const { resolvedAppearance } = usePreferences();
  const { enableBackgroundImage, backgroundMediaType, isReady } = useThemeSettings();
  const isMobile = useMediaQuery(MOBILE_VIEWPORT_QUERY, true);
  const reducedMotion = useMediaQuery(REDUCED_MOTION_QUERY, true);
  const saveData = useSaveDataPreference();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const pondRef = useRef<PondInstance | null>(null);
  const themeRef = useRef(resolvedAppearance);
  const lastThemeRef = useRef(resolvedAppearance);
  const [failed, setFailed] = useState(false);
  themeRef.current = resolvedAppearance;
  const active =
    isReady &&
    enableBackgroundImage &&
    backgroundMediaType === "pond" &&
    !reducedMotion &&
    !saveData &&
    !failed;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !active) return;
    let disposed = false;
    let starting = false;
    let frame = 0;
    let idle = 0;
    let timer: number | undefined;
    const start = async () => {
      if (disposed || document.hidden || starting || pondRef.current) return;
      starting = true;
      try {
        const { mount } = await import("@/vendor/ascii-pond/pond.js");
        if (disposed || document.hidden || !canvasRef.current) return;
        pondRef.current = mount(canvasRef.current, {
          species: [{ type: "koi", count: isMobile ? 2 : 4, young: isMobile ? 1 : 2 }],
          theme: themeRef.current === "dark" ? "dark" : "light",
          maxFps: isMobile ? 24 : 30,
          maxDpr: isMobile ? 1 : 1.5,
          contentRoot: document.getElementById("root") ?? document,
        });
      } catch {
        if (!disposed) setFailed(true);
      } finally {
        starting = false;
      }
    };
    // 与视频层同理:让首屏内容和 API 请求先跑,再在空闲时启动水塘引擎;调度可整体取消,
    // 覆盖 StrictMode 的弃用挂载和隐藏标签页。
    const schedule = () => {
      if (disposed || document.hidden || pondRef.current || frame || idle || timer) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        if (typeof window.requestIdleCallback === "function") {
          idle = window.requestIdleCallback(
            () => {
              idle = 0;
              void start();
            },
            { timeout: 500 },
          );
        } else {
          timer = window.setTimeout(() => {
            timer = undefined;
            void start();
          }, 0);
        }
      });
    };
    // 引擎的帧循环在页面隐藏时会自然停住,但不会自己恢复,由这里负责暂停/续播。
    const onVisibilityChange = () => {
      const pond = pondRef.current;
      if (!pond) {
        schedule();
        return;
      }
      if (document.hidden) pond.pause();
      else pond.resume();
    };
    schedule();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      disposed = true;
      window.cancelAnimationFrame(frame);
      if (idle) window.cancelIdleCallback(idle);
      if (timer) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      pondRef.current?.destroy();
      pondRef.current = null;
    };
  }, [active, isMobile]);

  // 外观切换不重建引擎:直接换调色板。不传坐标,避免引擎的墨洗动画把整页底色刷过背景图。
  useEffect(() => {
    if (lastThemeRef.current === resolvedAppearance) return;
    lastThemeRef.current = resolvedAppearance;
    pondRef.current?.setTheme(resolvedAppearance === "light");
  }, [resolvedAppearance]);

  if (!active) return null;
  return <canvas ref={canvasRef} className="pond-background-layer" aria-hidden="true" />;
}
