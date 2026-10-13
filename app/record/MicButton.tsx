"use client";

import type { KeyboardEvent, PointerEvent } from "react";
import type { MicController, MicMode, MicState } from "@/lib/holdToTalk";
import type { Lang } from "@/lib/i18n";
import { t } from "@/lib/text";

/**
 * The mic button. Hold mode: press and hold (pointer or spacebar) to talk, release to send.
 * Tap mode: press to start, press again to stop. The logic lives in lib/holdToTalk.ts.
 */
export function MicButton({
  mic,
  mode,
  state,
  lang,
  hint,
}: {
  mic: MicController;
  mode: MicMode;
  state: MicState;
  lang: Lang;
  hint: "too_short" | null;
}) {
  const recording = state === "recording";
  const label =
    mode === "hold" ? t(recording ? "ui.mic.recording" : "ui.mic.hold", lang) : t(recording ? "ui.mic.tap_stop" : "ui.mic.tap_start", lang);

  const down = (e: PointerEvent<HTMLButtonElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.preventDefault(); // no focus-steal, text selection or long-press menu
    e.currentTarget.focus();
    mic.press();
  };
  const key = (e: KeyboardEvent<HTMLButtonElement>, isDown: boolean) => {
    if (e.key !== " " && e.code !== "Space") return;
    e.preventDefault(); // the spacebar would otherwise "click" the button
    if (isDown) {
      if (!e.repeat) mic.press();
    } else mic.release();
  };

  return (
    <div className="mic">
      <button
        type="button"
        className={`mic-button${recording ? " recording" : ""}${state === "pressed" ? " pressed" : ""}`}
        aria-pressed={state !== "idle"}
        aria-label={label}
        onPointerDown={down}
        onPointerUp={() => mic.release()}
        onPointerCancel={() => mic.cancel()}
        onPointerLeave={() => mic.cancel()}
        onContextMenu={(e) => e.preventDefault()}
        onKeyDown={(e) => key(e, true)}
        onKeyUp={(e) => key(e, false)}
        onBlur={() => mic.cancel()}
      >
        <span className="mic-dot" aria-hidden="true" />
        {label}
      </button>
      <span className="small muted" role="status" aria-live="polite">
        {recording ? "Recording…" : hint === "too_short" ? t("ui.mic.too_short", lang) : ""}
      </span>
    </div>
  );
}
