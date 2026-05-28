// Shared CSS for the v4 redesign. Injected once at the WorkflowShell
// level and scoped under the `.pm4` root so it never fights the legacy
// sage/warm tokens the capture/watch/compliance pages still use.
//
// Keeps the design tokens from the mockup (navy, seafoam, gray ramp,
// Fraunces/Inter/JetBrains Mono) alongside the element-level styles
// (header, nav, page hero, cards, funnel, sticky bottom bar, form
// atoms, etc).
export const V4_CSS = `
.pm4 { font-family: var(--v4-fb); color: var(--v4-g900); background: var(--v4-g50);
  -webkit-font-smoothing: antialiased; min-height: 100vh;
  display: flex; flex-direction: column;
}
.pm4 *, .pm4 *::before, .pm4 *::after { box-sizing: border-box; }

/* ── GLOBAL HEADER ── */
.pm4 .ghdr { background: var(--v4-navy); padding: 0 28px;
  display: flex; align-items: center; justify-content: space-between;
  height: 54px; position: sticky; top: 0; z-index: 200;
}
.pm4 .ghdr-l { display: flex; align-items: center; gap: 16px; }
.pm4 .logo { font-family: var(--v4-fd); color: #fff; font-size: 20px;
  font-weight: 700; cursor: pointer; }
.pm4 .logo span { color: var(--v4-sea); }
.pm4 .spills { display: flex; gap: 3px; }
.pm4 .sp { padding: 3px 10px; border-radius: 5px; font-size: 10px;
  font-weight: 600; cursor: pointer; border: 1px solid rgba(255,255,255,0.1);
  background: rgba(255,255,255,0.05); color: var(--v4-g400); }
.pm4 .sp.on { background: var(--v4-sea); color: var(--v4-navy); border-color: var(--v4-sea); }
.pm4 .ghdr-r { display: flex; align-items: center; gap: 10px; }
.pm4 .ghdr-btn { background: rgba(255,255,255,0.06);
  border: 1px solid rgba(255,255,255,0.1); border-radius: 7px;
  padding: 6px 12px; color: #fff; font-size: 11px; font-weight: 500;
  cursor: pointer; font-family: var(--v4-fb); }
.pm4 .broker-b { display: flex; align-items: center; gap: 7px;
  background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1);
  border-radius: 7px; padding: 4px 10px; }
.pm4 .bav { width: 26px; height: 26px; border-radius: 50%; background: var(--v4-sea);
  display: flex; align-items: center; justify-content: center; font-size: 10px;
  font-weight: 700; color: var(--v4-navy); }
.pm4 .bn { color: #fff; font-size: 11px; font-weight: 600; }
.pm4 .bnpn { color: var(--v4-g500); font-size: 9px; font-family: var(--v4-fm); }

/* ── WORKFLOW NAV ── */
.pm4 .wnav { background: var(--v4-navy-dk); display: flex;
  justify-content: center; gap: 0; border-bottom: 1px solid rgba(255,255,255,0.06); }
.pm4 .wstep { padding: 10px 28px; font-size: 12px; font-weight: 600;
  color: var(--v4-g500); cursor: pointer; border-bottom: 2px solid transparent;
  transition: all 0.15s; display: flex; align-items: center; gap: 6px;
  font-family: var(--v4-fb); background: transparent; border-left: 0;
  border-right: 0; border-top: 0; }
.pm4 .wstep.active { color: var(--v4-sea); border-bottom-color: var(--v4-sea); }
.pm4 .wstep.done { color: var(--v4-grn); }
.pm4 .wstep:hover:not(.active):not(:disabled) { color: var(--v4-g300); }
.pm4 .wstep:disabled { opacity: 0.55; cursor: not-allowed; }
.pm4 .wnum { width: 20px; height: 20px; border-radius: 50%; font-size: 10px;
  font-weight: 700; display: flex; align-items: center; justify-content: center;
  border: 1.5px solid currentColor; }
.pm4 .wstep.done .wnum { background: var(--v4-grn); color: #fff;
  border-color: var(--v4-grn); }
.pm4 .wstep.active .wnum { background: var(--v4-sea); color: var(--v4-navy);
  border-color: var(--v4-sea); }

/* ── PAGE CHROME ── */
.pm4 .page { flex: 1 1 auto; display: flex; flex-direction: column; min-height: 0; }
.pm4 .scroll { flex: 1 1 auto; overflow-y: auto; }
.pm4 .phdr { background: linear-gradient(180deg, var(--v4-navy) 0%, var(--v4-navy-dk) 100%);
  padding: 24px 32px 32px; }
.pm4 .ptitle { font-family: var(--v4-fd); font-size: 22px; font-weight: 700; color: #fff; }
.pm4 .psub { color: var(--v4-g500); font-size: 12px; margin-top: 3px; }
.pm4 .pclient { display: inline-flex; align-items: center; gap: 6px;
  background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1);
  border-radius: 7px; padding: 4px 12px; margin-top: 10px; color: #fff; font-size: 11px; }
.pm4 .pclient strong { color: var(--v4-sea); }
.pm4 .cnt { max-width: 880px; margin: -16px auto 0; padding: 0 32px 80px;
  position: relative; z-index: 10; width: 100%; }
.pm4 .cnt.cnt-wide { max-width: 1320px; }

/* ── CARDS + LISTS ── */
.pm4 .card { background: #fff; border-radius: 11px; border: 1px solid var(--v4-g200);
  margin-bottom: 14px; overflow: hidden; }
.pm4 .chdr { padding: 11px 16px; display: flex; align-items: center;
  justify-content: space-between; border-bottom: 1px solid var(--v4-g100); }
.pm4 .cht { font-size: 13px; font-weight: 700; color: var(--v4-g900); }
.pm4 .chc { font-family: var(--v4-fm); font-size: 11px; color: var(--v4-g500); }
.pm4 .chact { font-size: 10px; font-weight: 600; color: var(--v4-navy); cursor: pointer; }

/* ── SEARCH BAR ── */
.pm4 .sb-wrap { position: relative; margin-bottom: 16px; }
.pm4 .sb { width: 100%; padding: 12px 16px 12px 40px; border-radius: 10px;
  border: 2px solid var(--v4-g300); background: #fff; font-size: 14px;
  font-family: var(--v4-fb); color: var(--v4-g900); outline: none;
  transition: all 0.2s; box-shadow: 0 1px 4px rgba(0,0,0,0.03); }
.pm4 .sb:focus { border-color: var(--v4-sea);
  box-shadow: 0 0 0 3px rgba(131,240,249,0.12); }
.pm4 .sb::placeholder { color: var(--v4-g400); }
.pm4 .sb-wrap .si { position: absolute; left: 14px; top: 50%;
  transform: translateY(-50%); color: var(--v4-g400); font-size: 14px;
  pointer-events: none; }

/* ── BUTTONS ── */
.pm4 .btn { padding: 7px 16px; border-radius: 7px; font-size: 12px; font-weight: 600;
  cursor: pointer; font-family: var(--v4-fb); border: none; transition: all 0.12s;
  display: inline-flex; align-items: center; gap: 5px; }
.pm4 .btn.sea { background: var(--v4-sea); color: var(--v4-navy); }
.pm4 .btn.sea:hover { background: #6de8f2; }
.pm4 .btn.pri { background: var(--v4-navy); color: #fff; }
.pm4 .btn.pri:hover { background: var(--v4-navy-lt); }
.pm4 .btn.out { background: #fff; color: var(--v4-g700); border: 1px solid var(--v4-g300); }
.pm4 .btn.out:hover { background: var(--v4-g50); }
.pm4 .btn:disabled { opacity: 0.55; cursor: not-allowed; }

/* ── BOTTOM BAR ── */
.pm4 .bbar { position: sticky; bottom: 0; background: #fff;
  border-top: 1px solid var(--v4-g200); padding: 10px 32px; display: flex;
  align-items: center; justify-content: space-between;
  box-shadow: 0 -2px 6px rgba(0,0,0,0.03); z-index: 50; gap: 12px; flex-wrap: wrap; }
.pm4 .bbar-info { font-size: 12px; color: var(--v4-g600); }
.pm4 .bbar-info strong { color: var(--v4-g900); }

/* ── FUNNEL ── */
.pm4 .funnel { background: #fff; border-radius: 11px; border: 1px solid var(--v4-g200);
  padding: 12px 16px; margin-bottom: 16px; display: flex; align-items: center; gap: 0; }
.pm4 .fs { flex: 1; text-align: center; }
.pm4 .fsn { font-family: var(--v4-fm); font-size: 20px; font-weight: 700;
  color: var(--v4-navy); }
.pm4 .fsl { font-size: 9px; color: var(--v4-g500); font-weight: 500;
  text-transform: uppercase; letter-spacing: .04em; margin-top: 1px; }
.pm4 .fa { color: var(--v4-g300); font-size: 16px; padding: 0 6px; }
.pm4 .fs.act .fsn { color: var(--v4-grn); }
.pm4 .sub { font-size: 10px; color: var(--v4-g500); font-weight: 400; }

/* ── LANDING HERO ── */
.pm4 .hero { background: linear-gradient(180deg, var(--v4-navy) 0%, var(--v4-navy-dk) 100%);
  padding: 36px 32px 44px; text-align: center; }
.pm4 .hero-g { font-family: var(--v4-fd); font-size: 26px; font-weight: 600;
  color: #fff; margin-bottom: 4px; }
.pm4 .hero-g span { color: var(--v4-sea); }
.pm4 .hero-s { color: var(--v4-g500); font-size: 13px; margin-bottom: 24px; }
.pm4 .hero .sb-wrap { max-width: 600px; margin: 0 auto; }
.pm4 .hero .sb { background: rgba(255,255,255,0.06);
  border-color: rgba(131,240,249,0.2); color: #fff; }
.pm4 .hero .sb:focus { border-color: var(--v4-sea);
  background: rgba(255,255,255,0.1); }
.pm4 .hero .sb::placeholder { color: var(--v4-g500); }
.pm4 .hero .si { color: var(--v4-g500); }
.pm4 .sa { display: flex; justify-content: center; gap: 8px; margin-top: 14px;
  flex-wrap: wrap; }
.pm4 .sa .btn { font-size: 12px; padding: 8px 18px; }
.pm4 .sa .btn.out { background: rgba(255,255,255,0.07); color: #fff;
  border-color: rgba(255,255,255,0.12); }

/* ── LANDING STATS ── */
.pm4 .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px;
  padding: 0 32px; margin-top: -20px; position: relative; z-index: 10; }
.pm4 .sc { background: #fff; border-radius: 10px; padding: 14px 16px;
  box-shadow: 0 1px 4px rgba(0,0,0,0.03); border: 1px solid var(--v4-g200);
  display: flex; align-items: center; gap: 12px; }
.pm4 .sci { width: 38px; height: 38px; border-radius: 9px; display: flex;
  align-items: center; justify-content: center; font-size: 17px; flex-shrink: 0; }
.pm4 .sci.bl { background: var(--v4-sea-dim); color: var(--v4-navy); }
.pm4 .sci.gr { background: var(--v4-grn-bg); color: var(--v4-grn); }
.pm4 .sci.am { background: var(--v4-amb-bg); color: var(--v4-amb); }
.pm4 .sci.rd { background: var(--v4-red-bg); color: var(--v4-red); }
.pm4 .scn { font-family: var(--v4-fm); font-size: 22px; font-weight: 700;
  color: var(--v4-g900); line-height: 1; }
.pm4 .scl { font-size: 10px; color: var(--v4-g600); font-weight: 500; margin-top: 1px; }

/* ── LANDING MAIN ── */
.pm4 .lmain { padding: 24px 32px; display: grid; grid-template-columns: 1fr 1fr;
  gap: 16px; }
.pm4 .lmain .card.span2 { grid-column: span 2; }
.pm4 .sr { padding: 10px 16px; display: flex; align-items: center; gap: 12px;
  border-bottom: 1px solid var(--v4-g100); cursor: pointer; transition: background 0.1s;
  background: #fff; border-left: 0; border-right: 0; border-top: 0; width: 100%;
  text-align: left; font-family: inherit; font-size: inherit; color: inherit; }
.pm4 .sr:hover { background: var(--v4-g50); }
.pm4 .sr:last-child { border-bottom: none; }
.pm4 .sra { width: 32px; height: 32px; border-radius: 50%; background: var(--v4-navy);
  display: flex; align-items: center; justify-content: center; font-size: 11px;
  font-weight: 700; color: var(--v4-sea); flex-shrink: 0; }
.pm4 .sri { flex: 1; min-width: 0; }
.pm4 .srn { font-size: 12px; font-weight: 600; color: var(--v4-g900);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pm4 .srd { font-size: 10px; color: var(--v4-g600); margin-top: 1px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pm4 .srr { text-align: right; }
.pm4 .srs { font-size: 9px; font-weight: 600; padding: 2px 7px; border-radius: 4px;
  display: inline-block; }
.pm4 .srs.q { background: var(--v4-sea-dim); color: var(--v4-navy); }
.pm4 .srs.e { background: var(--v4-grn-bg); color: var(--v4-grn); }
.pm4 .srs.r { background: var(--v4-amb-bg); color: var(--v4-amb); }
.pm4 .srs.p { background: var(--v4-g100); color: var(--v4-g600); }
.pm4 .srt { font-size: 9px; color: var(--v4-g500); margin-top: 2px;
  font-family: var(--v4-fm); }

.pm4 .ar { padding: 10px 16px; display: flex; align-items: center; gap: 10px;
  border-bottom: 1px solid var(--v4-g100); }
.pm4 .ar:last-child { border-bottom: none; }
.pm4 .adot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
.pm4 .adot.u { background: var(--v4-red); }
.pm4 .adot.w { background: var(--v4-amb); }
.pm4 .adot.i { background: var(--v4-navy); }
.pm4 .ai { flex: 1; min-width: 0; }
.pm4 .ain { font-size: 12px; font-weight: 600; color: var(--v4-g900); }
.pm4 .air { font-size: 10px; color: var(--v4-g600); margin-top: 1px; }
.pm4 .aact { font-size: 9px; font-weight: 600; color: var(--v4-navy);
  background: var(--v4-sea-dim); padding: 3px 8px; border-radius: 4px;
  cursor: pointer; white-space: nowrap; border: none; }

.pm4 .qsg { padding: 14px; display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.pm4 .qsc { padding: 12px; border-radius: 8px; border: 1px solid var(--v4-g200);
  cursor: pointer; transition: all 0.12s; text-align: center; background: #fff; }
.pm4 .qsc:hover { border-color: var(--v4-sea); background: var(--v4-sea-dim); }
.pm4 .qsi { font-size: 20px; margin-bottom: 4px; }
.pm4 .qsn { font-size: 11px; font-weight: 600; color: var(--v4-g800); }
.pm4 .qss { font-size: 9px; color: var(--v4-g500); margin-top: 1px; }
.pm4 .qsc:disabled { opacity: 0.55; cursor: not-allowed; }

.pm4 .aep { display: grid; grid-template-columns: 1fr 1fr 1fr; }
.pm4 .aepr { padding: 10px 16px; display: flex; align-items: center; gap: 10px; }
.pm4 .aepm { flex: 1; }
.pm4 .aepl { font-size: 10px; color: var(--v4-g600); font-weight: 500; }
.pm4 .aepv { font-family: var(--v4-fm); font-size: 16px; font-weight: 700;
  color: var(--v4-g900); margin-top: 1px; }
.pm4 .aepbw { flex: 2; height: 7px; background: var(--v4-g200); border-radius: 4px;
  overflow: hidden; }
.pm4 .aepb { height: 100%; border-radius: 4px; }
.pm4 .aepb.g { background: var(--v4-grn); }
.pm4 .aepb.n { background: var(--v4-navy); }
.pm4 .aepb.a { background: var(--v4-amb); }
.pm4 .aepp { font-family: var(--v4-fm); font-size: 11px; font-weight: 600;
  color: var(--v4-g700); min-width: 36px; text-align: right; }

/* ── FORM ATOMS (intake) ── */
.pm4 .form-group { margin-bottom: 16px; }
.pm4 .form-label { font-size: 11px; font-weight: 600; color: var(--v4-g700);
  text-transform: uppercase; letter-spacing: .04em; margin-bottom: 5px; display: block; }
.pm4 .form-input { width: 100%; padding: 10px 14px; border-radius: 8px;
  border: 1.5px solid var(--v4-g300); font-size: 14px; font-family: var(--v4-fb);
  color: var(--v4-g900); outline: none; transition: all 0.15s; background: #fff; }
.pm4 .form-input:focus { border-color: var(--v4-sea);
  box-shadow: 0 0 0 3px rgba(131,240,249,0.1); }
.pm4 .form-input[disabled] { background: var(--v4-g100); }
.pm4 .form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.pm4 .plan-types { display: flex; gap: 8px; flex-wrap: wrap; }
.pm4 .pt-card { flex: 1; min-width: 120px; padding: 12px; border-radius: 8px;
  border: 2px solid var(--v4-g200); cursor: pointer; text-align: center;
  transition: all 0.15s; background: #fff; }
.pm4 .pt-card.active { border-color: var(--v4-sea); background: var(--v4-sea-dim); }
.pm4 .pt-card:hover:not(.active) { border-color: var(--v4-g400); }
.pm4 .pt-card.active .ptn { color: var(--v4-navy); }
.pm4 .ptn { font-size: 13px; font-weight: 700; color: var(--v4-g900); }
.pm4 .pts { font-size: 10px; color: var(--v4-g500); margin-top: 2px; }

/* ── CAPTURE BAR (meds + providers) ── */
.pm4 .cap-bar { background: linear-gradient(135deg, var(--v4-navy), var(--v4-navy-lt));
  border-radius: 9px; padding: 12px 16px; margin-bottom: 16px; display: flex;
  align-items: center; gap: 12px; cursor: pointer; transition: all 0.12s;
  border: none; color: inherit; font-family: inherit; width: 100%; text-align: left; }
.pm4 .cap-bar:hover { transform: translateY(-1px); box-shadow: 0 3px 12px rgba(0,0,0,0.12); }
.pm4 .cap-i { font-size: 20px; }
.pm4 .cap-t { color: #fff; font-size: 12px; font-weight: 600; }
.pm4 .cap-s { color: var(--v4-g500); font-size: 10px; margin-top: 1px; }

/* ── MEDICATION ITEMS ── */
.pm4 .mi { padding: 12px 16px; display: flex; align-items: flex-start; gap: 12px;
  border-bottom: 1px solid var(--v4-g100); }
.pm4 .mi:last-child { border-bottom: none; }
.pm4 .minfo { flex: 1; min-width: 0; }
.pm4 .mname { font-size: 13px; font-weight: 600; color: var(--v4-g900); }
.pm4 .mdet { font-size: 10px; color: var(--v4-g600); margin-top: 2px;
  display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.pm4 .mrx { font-family: var(--v4-fm); font-size: 9px; color: var(--v4-g500);
  background: var(--v4-g100); padding: 1px 5px; border-radius: 3px; }
.pm4 .mconf { font-size: 9px; font-weight: 600; padding: 1px 5px; border-radius: 3px; }
.pm4 .mconf.h { background: var(--v4-grn-bg); color: var(--v4-grn); }
.pm4 .mphoto { font-size: 8px; font-weight: 600; background: var(--v4-sea-dim);
  color: var(--v4-navy); padding: 1px 5px; border-radius: 3px; }
.pm4 .trow { display: flex; gap: 3px; margin-top: 6px; flex-wrap: wrap; }
.pm4 .tb { font-size: 9px; font-weight: 600; padding: 2px 7px; border-radius: 4px;
  font-family: var(--v4-fm); display: inline-flex; align-items: center; gap: 2px; }
.pm4 .tb.cov { background: var(--v4-grn-bg); color: var(--v4-grn);
  border: 1px solid var(--v4-grn-bdr); }
.pm4 .tb.not { background: var(--v4-red-bg); color: var(--v4-red);
  border: 1px solid var(--v4-red-bdr); }
.pm4 .tb.wrn { background: var(--v4-amb-bg); color: var(--v4-amb); }
.pm4 .mact { display: flex; flex-direction: column; gap: 3px; align-items: flex-end;
  flex-shrink: 0; }
.pm4 .mrem { font-size: 10px; color: var(--v4-red); cursor: pointer; font-weight: 500;
  background: none; border: none; padding: 0; font-family: inherit; }

/* ── PROVIDER ITEMS ── */
.pm4 .pi { padding: 12px 16px; display: flex; align-items: flex-start; gap: 12px;
  border-bottom: 1px solid var(--v4-g100); }
.pm4 .pi:last-child { border-bottom: none; }
.pm4 .pav { width: 38px; height: 38px; border-radius: 50%; background: var(--v4-navy);
  display: flex; align-items: center; justify-content: center; font-size: 13px;
  font-weight: 700; color: var(--v4-sea); flex-shrink: 0; }
.pm4 .pinfo { flex: 1; min-width: 0; }
.pm4 .pname { font-size: 13px; font-weight: 600; color: var(--v4-g900); }
.pm4 .pspec { font-size: 11px; color: var(--v4-g600); margin-top: 1px; }
.pm4 .paddr { font-size: 10px; color: var(--v4-g500); margin-top: 1px; }
.pm4 .pnpi { font-family: var(--v4-fm); font-size: 9px; color: var(--v4-g500);
  margin-top: 3px; }
.pm4 .pnpi span { background: var(--v4-g100); padding: 1px 5px; border-radius: 3px; }
.pm4 .nrow { display: flex; gap: 3px; margin-top: 6px; flex-wrap: wrap; }
.pm4 .nb { font-size: 9px; font-weight: 600; padding: 2px 7px; border-radius: 4px;
  display: inline-flex; align-items: center; gap: 2px; }
.pm4 .nb.in { background: var(--v4-grn-bg); color: var(--v4-grn);
  border: 1px solid var(--v4-grn-bdr); }
.pm4 .nb.ot { background: var(--v4-red-bg); color: var(--v4-red);
  border: 1px solid var(--v4-red-bdr); }
.pm4 .mo { background: var(--v4-grn-bg); border: 1px solid var(--v4-grn-bdr);
  border-radius: 7px; padding: 7px 12px; margin-top: 5px; display: flex;
  align-items: center; gap: 7px; font-size: 10px; color: var(--v4-grn); font-weight: 500; }
.pm4 .moc { width: 16px; height: 16px; border-radius: 3px; background: var(--v4-grn);
  display: flex; align-items: center; justify-content: center; color: #fff;
  font-size: 10px; font-weight: 700; flex-shrink: 0; }

/* ── FUNNEL SUMMARY CARD ── */
.pm4 .fsm { background: #fff; border-radius: 11px; border: 1px solid var(--v4-g200);
  padding: 14px 16px; margin-bottom: 16px; }
.pm4 .fst { font-size: 12px; font-weight: 700; color: var(--v4-g900); margin-bottom: 8px; }
.pm4 .fsr { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
.pm4 .fsc { width: 16px; height: 16px; border-radius: 3px; display: flex;
  align-items: center; justify-content: center; font-size: 9px; font-weight: 700;
  flex-shrink: 0; }
.pm4 .fsc.p { background: var(--v4-grn-bg); color: var(--v4-grn); }
.pm4 .fsc.f { background: var(--v4-red-bg); color: var(--v4-red); }
.pm4 .fsx { font-size: 11px; color: var(--v4-g700); }
.pm4 .fsx strong { color: var(--v4-g900); }

/* ── EXTRAS FILTER CARDS ── */
.pm4 .exg { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px;
  margin-bottom: 16px; }
.pm4 .exc { background: #fff; border-radius: 10px; border: 2px solid var(--v4-g200);
  padding: 14px; cursor: pointer; transition: all 0.12s; }
.pm4 .exc:hover { border-color: var(--v4-g400); }
.pm4 .exc.req { border-color: var(--v4-sea); background: var(--v4-sea-dim); }
.pm4 .ect { display: flex; align-items: center; justify-content: space-between;
  margin-bottom: 8px; }
.pm4 .ecn { font-size: 13px; font-weight: 700; color: var(--v4-g900); }
.pm4 .ectg { width: 32px; height: 18px; border-radius: 9px; position: relative;
  cursor: pointer; transition: all 0.15s; border: none; padding: 0; }
.pm4 .ectg.off { background: var(--v4-g300); }
.pm4 .ectg.on { background: var(--v4-grn); }
.pm4 .ectg::after { content: ''; position: absolute; top: 2px; left: 2px;
  width: 14px; height: 14px; border-radius: 50%; background: #fff;
  transition: all 0.15s; box-shadow: 0 1px 2px rgba(0,0,0,0.12); }
.pm4 .ectg.on::after { left: 16px; }
.pm4 .ectrs { display: flex; gap: 3px; margin-bottom: 6px; }
.pm4 .ectr { flex: 1; padding: 4px 3px; border-radius: 5px; text-align: center;
  font-size: 9px; font-weight: 600; cursor: pointer; border: 1px solid var(--v4-g200);
  color: var(--v4-g600); transition: all 0.1s; background: #fff; }
.pm4 .ectr.a { background: var(--v4-navy); color: #fff; border-color: var(--v4-navy); }
.pm4 .ecv { font-family: var(--v4-fm); font-size: 14px; font-weight: 700;
  color: var(--v4-navy); }
.pm4 .ecv.muted { color: var(--v4-g400); }
.pm4 .ecd { font-size: 9px; color: var(--v4-g500); margin-top: 1px; }
.pm4 .eci { margin-top: 6px; padding-top: 6px; border-top: 1px solid var(--v4-g200);
  font-size: 9px; color: var(--v4-g600); }
.pm4 .eci strong { color: var(--v4-g900); }
`;
