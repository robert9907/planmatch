// Global CSS for the agent-v3 shell. Scoped with a `.pma3` class on
// the root so it never collides with the v4 (.pm4) tokens or the
// legacy sage tokens used by the capture/watch pages.
//
// The mockup leans heavily on inline styles for pixel fidelity. We
// only externalize:
//   • keyframes (fadeSlideIn, spin, pulse) — can't inline these
//   • the .spinner / .pulsedot atoms — referenced by className from
//     several places
//   • a font import — Fraunces/Inter/JetBrains Mono are already loaded
//     by the v4 shell via globals; we re-import here so the agent-v3
//     URL works standalone.
import { TOKENS as T } from './compare-v2/tokens';

export const AGENT_V3_CSS = `
.pma3 {
  font-family: 'Inter', system-ui, sans-serif;
  min-height: 100vh;
  background: linear-gradient(180deg, #f0f7ff 0%, #f8fafc 30%, #fff 100%);
  color: #0d2f5e;
  -webkit-font-smoothing: antialiased;
}
.pma3 *, .pma3 *::before, .pma3 *::after { box-sizing: border-box; }
.pma3 button { font-family: inherit; }
.pma3 input, .pma3 textarea, .pma3 select { font-family: inherit; }

@keyframes pma3-fadeSlideIn { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }
@keyframes pma3-spin { to { transform: rotate(360deg); } }
@keyframes pma3-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
.pma3 .pma3-spinner {
  border: 2px solid #e2e8f0;
  border-top-color: #0d2f5e;
  border-radius: 50%;
  animation: pma3-spin 0.6s linear infinite;
}
.pma3 .pma3-pulsedot {
  width: 5px; height: 5px; border-radius: 50%;
  display: inline-block; background: currentColor;
  animation: pma3-pulse 1s infinite;
}
/* ---------------------------------------------------------------
   Button system (see compare-v2/Button.tsx for the rationale).
   Rank is carried by weight, not hue. Labels never wrap.
   --------------------------------------------------------------- */
.pma3 .pma3-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border: 1px solid transparent;
  border-radius: 8px;
  font-family: inherit;
  font-weight: 600;
  line-height: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  text-align: center;
  cursor: pointer;
  user-select: none;
  transition: background-color 140ms, border-color 140ms, color 140ms,
              box-shadow 140ms, transform 70ms;
}
.pma3 .pma3-btn:focus-visible {
  outline: 2px solid ${T.mint700};
  outline-offset: 2px;
}
.pma3 .pma3-btn:not(:disabled):active { transform: scale(0.982); }
.pma3 .pma3-btn:disabled { cursor: not-allowed; box-shadow: none; }

/* sizes */
.pma3 .pma3-btn--md { height: 38px; padding: 0 16px; font-size: 13px; letter-spacing: -0.005em; }
.pma3 .pma3-btn--sm { height: 32px; padding: 0 11px; font-size: 11.5px; }
.pma3 .pma3-btn--block { width: 100%; }

/* tier 1 — primary */
.pma3 .pma3-btn--primary {
  background: ${T.mint700};
  color: #FFFFFF;
  box-shadow: 0 1px 2px rgba(5, 38, 26, 0.18);
}
.pma3 .pma3-btn--primary:not(:disabled):hover { background: ${T.mint800}; }
.pma3 .pma3-btn--primary:not(:disabled):active { background: ${T.mint900}; }
.pma3 .pma3-btn--primary:disabled { background: ${T.lineStrong}; color: ${T.muted}; }

/* tier 2 — secondary */
.pma3 .pma3-btn--secondary {
  background: ${T.mint100};
  color: ${T.mint700};
  border-color: #C8EDDF;
}
.pma3 .pma3-btn--secondary:not(:disabled):hover { background: #D3F2E5; }
.pma3 .pma3-btn--secondary:not(:disabled):active { border-color: ${T.mint700}; }
.pma3 .pma3-btn--secondary:disabled { background: ${T.paper}; color: ${T.muted2}; border-color: ${T.line}; }

/* tier 3 — quiet */
.pma3 .pma3-btn--quiet {
  background: ${T.card};
  color: ${T.ink};
  border-color: ${T.lineStrong};
}
.pma3 .pma3-btn--quiet:not(:disabled):hover { background: ${T.paper}; border-color: ${T.muted2}; }
.pma3 .pma3-btn--quiet:not(:disabled):active { background: ${T.line}; }
.pma3 .pma3-btn--quiet:disabled { color: ${T.muted2}; border-color: ${T.line}; background: ${T.card}; }

@media (prefers-reduced-motion: reduce) {
  .pma3 .pma3-btn { transition: none; }
  .pma3 .pma3-btn:not(:disabled):active { transform: none; }
}
`;

// Single shared keyframe name re-exported so screen components can
// reference the same animation in inline styles.
export const FADE_SLIDE_IN = 'pma3-fadeSlideIn';
