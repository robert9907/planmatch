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
`;

// Single shared keyframe name re-exported so screen components can
// reference the same animation in inline styles.
export const FADE_SLIDE_IN = 'pma3-fadeSlideIn';
