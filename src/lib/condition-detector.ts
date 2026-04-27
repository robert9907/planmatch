// condition-detector — auto-detect chronic conditions from a client's
// medication list, with broker-facing implications.
//
// Pure function. No DB, no network. Takes Medication[] (just .name is
// used; rxcui isn't required so this works for hand-typed meds before
// RxNorm resolution).
//
// Confidence semantics:
//   certain  — disease-defining drug is present, OR a strict 2+
//              combination only used together for that condition.
//   likely   — single drug from the condition's drug class is present
//              and could be off-label (e.g. metformin for PCOS, but
//              that's rare in 65+ Medicare population so we still
//              call diabetes "likely").
//   possible — soft signal only (one BP med could just be cardio
//              prevention; one SSRI is depression, not anxiety).
//
// brokerImplications is what the agent actually needs to think about
// during plan selection, written in their voice. Keep them short — the
// UI will render these as one-liners under the condition pill.

export type Condition =
  | 'diabetes'
  | 'chf'
  | 'copd'
  | 'ckd'
  | 'hypertension'
  | 'afib';

export type Confidence = 'certain' | 'likely' | 'possible';

export interface DetectedCondition {
  condition: Condition;
  confidence: Confidence;
  triggerMeds: string[];
  brokerImplications: string[];
}

interface MedInput {
  name: string;
  rxcui?: string | null;
}

// Drug-name patterns. Matched case-insensitive against medication.name.
// Generic + brand names included. Keep these tight — false positives
// drive a chronic-condition pill onto the broker's screen and the
// rule engine will then boost C-SNPs that don't apply.
const PATTERNS = {
  // Diabetes: GLP-1s, SGLT-2s, DPP-4s, biguanides, sulfonylureas,
  // thiazolidinediones, all insulins, meglitinides.
  diabetes: [
    /\bmetformin\b/i, /\bglucophage\b/i,
    /\bozempic\b/i, /\bsemaglutide\b/i, /\brybelsus\b/i, /\bwegovy\b/i,
    /\bmounjaro\b/i, /\btirzepatide\b/i, /\bzepbound\b/i,
    /\btrulicity\b/i, /\bdulaglutide\b/i,
    /\bvictoza\b/i, /\bliraglutide\b/i, /\bsaxenda\b/i,
    /\bjardiance\b/i, /\bempagliflozin\b/i,
    /\bfarxiga\b/i, /\bdapagliflozin\b/i,
    /\binvokana\b/i, /\bcanagliflozin\b/i,
    /\bsteglatro\b/i, /\bertugliflozin\b/i,
    /\bjanuvia\b/i, /\bsitagliptin\b/i,
    /\btradjenta\b/i, /\blinagliptin\b/i,
    /\bonglyza\b/i, /\bsaxagliptin\b/i,
    /\bglipizide\b/i, /\bglucotrol\b/i,
    /\bglyburide\b/i, /\bglimepiride\b/i, /\bamaryl\b/i,
    /\bpioglitazone\b/i, /\bactos\b/i,
    /\brosiglitazone\b/i, /\bavandia\b/i,
    /\brepaglinide\b/i, /\bprandin\b/i, /\bnateglinide\b/i,
    /\binsulin\b/i, /\bhumalog\b/i, /\bnovolog\b/i, /\blantus\b/i,
    /\blevemir\b/i, /\btresiba\b/i, /\btoujeo\b/i, /\bbasaglar\b/i,
    /\bhumulin\b/i, /\bnovolin\b/i, /\bafrezza\b/i, /\bfiasp\b/i,
    /\blyumjev\b/i, /\bryzodeg\b/i,
  ],
  // CHF: Entresto is disease-defining in modern HF guidelines.
  // Other supportive meds: beta-blockers used in HF (carvedilol,
  // metoprolol succinate), MRAs (spironolactone, eplerenone), loop
  // diuretics (furosemide, torsemide, bumetanide).
  chf_defining: [
    /\bentresto\b/i, /\bsacubitril\b/i,
  ],
  chf_supportive: [
    /\bcarvedilol\b/i, /\bcoreg\b/i,
    /\bmetoprolol\s+succinate\b/i, /\btoprol[- ]?xl\b/i,
    /\bspironolactone\b/i, /\baldactone\b/i,
    /\beplerenone\b/i, /\binspra\b/i,
    /\bfurosemide\b/i, /\blasix\b/i,
    /\btorsemide\b/i, /\bdemadex\b/i,
    /\bbumetanide\b/i, /\bbumex\b/i,
    /\bdigoxin\b/i, /\blanoxin\b/i,
    /\bivabradine\b/i, /\bcorlanor\b/i,
  ],
  // COPD: ICS/LABA + LAMA combos are the disease signal.
  copd_combo: [
    /\btrelegy\b/i, /\bbreo\b/i, /\bsymbicort\b/i, /\badvair\b/i,
    /\bdulera\b/i, /\bwixela\b/i, /\bairsupra\b/i, /\bbreyna\b/i,
  ],
  copd_lama: [
    /\bspiriva\b/i, /\btiotropium\b/i,
    /\bincruse\b/i, /\bumeclidinium\b/i,
    /\bseebri\b/i, /\bglycopyrrolate\s+inhal/i,
    /\btudorza\b/i, /\baclidinium\b/i,
  ],
  copd_other: [
    /\balbuterol\b/i, /\bventolin\b/i, /\bproair\b/i, /\bproventil\b/i,
    /\blevalbuterol\b/i, /\bxopenex\b/i,
    /\bipratropium\b/i, /\batrovent\b/i, /\bcombivent\b/i,
    /\barformoterol\b/i, /\bbrovana\b/i,
    /\bformoterol\b/i, /\bperforomist\b/i,
    /\broflumilast\b/i, /\bdaliresp\b/i,
  ],
  // CKD: stage-3+ specific drugs. Phosphate binders, ESAs, finerenone.
  ckd_specific: [
    /\bkerendia\b/i, /\bfinerenone\b/i,
    /\bsevelamer\b/i, /\brenvela\b/i, /\brenagel\b/i,
    /\blanthanum\b/i, /\bfosrenol\b/i,
    /\bvelphoro\b/i, /\bsucroferric\b/i,
    /\bauryxia\b/i, /\bferric\s+citrate\b/i,
    /\bcalcium\s+acetate\b/i, /\bphoslo\b/i,
    /\bepoetin\b/i, /\bepogen\b/i, /\bprocrit\b/i,
    /\bdarbepoetin\b/i, /\baranesp\b/i,
    /\bmircera\b/i, /\bmethoxy\s+polyethylene\b/i,
    /\bcinacalcet\b/i, /\bsensipar\b/i,
    /\betelcalcetide\b/i, /\bparsabiv\b/i,
    /\bdaprodustat\b/i, /\bjesduvroq\b/i,
  ],
  // Hypertension: ACE-Is, ARBs, CCBs, thiazides. We DON'T count
  // beta-blockers alone as HTN since they're cardiac-multipurpose.
  hypertension: [
    /\blisinopril\b/i, /\bzestril\b/i, /\bprinivil\b/i,
    /\benalapril\b/i, /\bvasotec\b/i,
    /\bramipril\b/i, /\baltace\b/i,
    /\bbenazepril\b/i, /\blotensin\b/i,
    /\bquinapril\b/i, /\baccupril\b/i,
    /\bperindopril\b/i, /\baceon\b/i,
    /\blosartan\b/i, /\bcozaar\b/i,
    /\bvalsartan\b/i, /\bdiovan\b/i,
    /\birbesartan\b/i, /\bavapro\b/i,
    /\bolmesartan\b/i, /\bbenicar\b/i,
    /\btelmisartan\b/i, /\bmicardis\b/i,
    /\bcandesartan\b/i, /\batacand\b/i,
    /\bamlodipine\b/i, /\bnorvasc\b/i,
    /\bnifedipine\b/i, /\bprocardia\b/i, /\badalat\b/i,
    /\bdiltiazem\b/i, /\bcardizem\b/i, /\btiazac\b/i,
    /\bverapamil\b/i, /\bcalan\b/i, /\bisoptin\b/i,
    /\bhydrochlorothiazide\b/i, /\bhctz\b/i, /\bmicrozide\b/i,
    /\bchlorthalidone\b/i,
    /\bindapamide\b/i,
  ],
  // AFib: anticoagulants paired with rate or rhythm control.
  afib_anticoag: [
    /\beliquis\b/i, /\bapixaban\b/i,
    /\bxarelto\b/i, /\brivaroxaban\b/i,
    /\bpradaxa\b/i, /\bdabigatran\b/i,
    /\bsavaysa\b/i, /\bedoxaban\b/i,
    /\bwarfarin\b/i, /\bcoumadin\b/i, /\bjantoven\b/i,
  ],
  afib_rhythm_rate: [
    /\bamiodarone\b/i, /\bpacerone\b/i,
    /\bsotalol\b/i, /\bbetapace\b/i,
    /\bdofetilide\b/i, /\btikosyn\b/i,
    /\bdronedarone\b/i, /\bmultaq\b/i,
    /\bflecainide\b/i, /\btambocor\b/i,
    /\bpropafenone\b/i, /\brythmol\b/i,
    /\bdigoxin\b/i, /\blanoxin\b/i,
    /\bdiltiazem\b/i, /\bverapamil\b/i,
    /\bmetoprolol\b/i, /\bcarvedilol\b/i, /\batenolol\b/i,
  ],
};

function matchAny(meds: MedInput[], patterns: RegExp[]): string[] {
  const hits: string[] = [];
  for (const m of meds) {
    if (!m.name) continue;
    for (const p of patterns) {
      if (p.test(m.name)) {
        hits.push(m.name);
        break;
      }
    }
  }
  return hits;
}

export function detectConditions(meds: MedInput[]): DetectedCondition[] {
  const out: DetectedCondition[] = [];

  // ── Diabetes ──
  const dmHits = matchAny(meds, PATTERNS.diabetes);
  if (dmHits.length >= 2) {
    out.push({
      condition: 'diabetes',
      confidence: 'certain',
      triggerMeds: dmHits,
      brokerImplications: [
        'Check C-SNP availability for diabetes — if Klein-style PCP is in-network, +25 boost lands it in top 3',
        'Confirm diabetic supplies coverage (test strips, CGM); plans without it lose -15',
        'Insulin user? IRA $35/mo cap is automatic on every Part D plan',
      ],
    });
  } else if (dmHits.length === 1) {
    out.push({
      condition: 'diabetes',
      confidence: 'likely',
      triggerMeds: dmHits,
      brokerImplications: [
        'Single diabetes-class drug — could be early-stage or off-label',
        'Ask about CGM, A1c, complications before assuming severity',
      ],
    });
  }

  // ── CHF ──
  const chfDefining = matchAny(meds, PATTERNS.chf_defining);
  const chfSupport = matchAny(meds, PATTERNS.chf_supportive);
  if (chfDefining.length > 0 || chfSupport.length >= 2) {
    out.push({
      condition: 'chf',
      confidence: 'certain',
      triggerMeds: [...chfDefining, ...chfSupport],
      brokerImplications: [
        'MOOP > $5,000 is a -20 penalty — CHF clients hit MOOP fast',
        'Cardiology C-SNP available? If provider is in-network, +25 boost',
        'Review inpatient day-1-5 copay; CHF readmits common',
      ],
    });
  } else if (chfSupport.length === 1) {
    out.push({
      condition: 'chf',
      confidence: 'possible',
      triggerMeds: chfSupport,
      brokerImplications: [
        'Single CHF-class drug — could be hypertension or post-MI prophylaxis',
      ],
    });
  }

  // ── COPD ──
  const copdCombo = matchAny(meds, PATTERNS.copd_combo);
  const copdLama = matchAny(meds, PATTERNS.copd_lama);
  const copdOther = matchAny(meds, PATTERNS.copd_other);
  const copdAll = [...copdCombo, ...copdLama, ...copdOther];
  if (copdCombo.length > 0 && copdLama.length > 0) {
    out.push({
      condition: 'copd',
      confidence: 'certain',
      triggerMeds: copdAll,
      brokerImplications: [
        'Inhaler tier placement is the decider — Trelegy/Breo on tier 4 vs tier 3 is $500+/yr',
        'Pulmonary rehab + DME (nebulizer, O2) — verify coverage before quoting',
      ],
    });
  } else if (copdAll.length >= 2) {
    out.push({
      condition: 'copd',
      confidence: 'likely',
      triggerMeds: copdAll,
      brokerImplications: [
        'Multiple inhalers — confirm asthma vs COPD with the client',
        'Inhaler cost variance across plans is the cost driver to watch',
      ],
    });
  } else if (copdAll.length === 1) {
    out.push({
      condition: 'copd',
      confidence: 'possible',
      triggerMeds: copdAll,
      brokerImplications: [
        'Single rescue inhaler — could be asthma; ask before assuming COPD',
      ],
    });
  }

  // ── CKD ──
  const ckdHits = matchAny(meds, PATTERNS.ckd_specific);
  if (ckdHits.length > 0) {
    out.push({
      condition: 'ckd',
      confidence: 'certain',
      triggerMeds: ckdHits,
      brokerImplications: [
        'CKD-specific drug — patient is at minimum stage 3, possibly on dialysis pathway',
        'Dialysis benefit, ESRD coverage, and nephrology specialist tier matter most',
      ],
    });
  }

  // ── Hypertension ──
  const htnHits = matchAny(meds, PATTERNS.hypertension);
  if (htnHits.length >= 2) {
    out.push({
      condition: 'hypertension',
      confidence: 'likely',
      triggerMeds: htnHits,
      brokerImplications: [
        'Multi-drug HTN — usually well-controlled but watch for CKD progression risk',
      ],
    });
  } else if (htnHits.length === 1) {
    out.push({
      condition: 'hypertension',
      confidence: 'possible',
      triggerMeds: htnHits,
      brokerImplications: [
        'Single BP med — could be cardio prevention without true HTN diagnosis',
      ],
    });
  }

  // ── AFib ──
  const aficoag = matchAny(meds, PATTERNS.afib_anticoag);
  const afctrl = matchAny(meds, PATTERNS.afib_rhythm_rate);
  if (aficoag.length > 0 && afctrl.length > 0) {
    out.push({
      condition: 'afib',
      confidence: 'certain',
      triggerMeds: [...aficoag, ...afctrl],
      brokerImplications: [
        'Eliquis + amiodarone-class combination — anticoagulant tier is the cost driver',
        'Stroke + bleed risk monitoring; nurse-line + telehealth benefit useful',
      ],
    });
  }

  return out;
}

// Convenience: collapse to a Set<Condition> for rules that just need
// to know "does this client have X".
export function conditionSet(detections: DetectedCondition[]): Set<Condition> {
  return new Set(detections.map((d) => d.condition));
}

// True when the client has zero certain/likely chronic conditions and
// zero meds — the "healthy newly-eligible" profile that benefits from
// extras-heavy plans.
export function isHealthyClient(
  meds: MedInput[],
  detections: DetectedCondition[],
): boolean {
  if (meds.length > 0) return false;
  return detections.every((d) => d.confidence === 'possible');
}
