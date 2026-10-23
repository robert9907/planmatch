#!/usr/bin/env python3
"""Build pm_plan_oon_costs rows from the CMS PBP Benefits file, Section C.

Usage:
  python3 -I scripts/cms-pbp/build-oon-costs.py <pbp_dir> <plan_triples.txt> <out.json>

<pbp_dir>         unzipped pbp-benefits-YYYY.zip (needs pbp_Section_C.txt,
                  pbp_Section_C_OON.txt, pbp_Section_C_POS.txt)
<plan_triples>    one "CONTRACT|PLAN|SEGMENT" per line — only these plans are
                  emitted (the pm_plans catalog for the year)
<out.json>        list of {contract_id, plan_id, segment_id, network_mode,
                  oon_moop, costs}

Every value is copied from the CMS filing. Nothing is defaulted: a service
the plan did not file out-of-network is simply absent from `costs`.

PBP service-category codes → MedicalCopays keys (same keys the agent and
consumer Plan objects use for in-network cost share).
"""
import csv
import json
import sys

csv.field_size_limit(10**9)

CODE_TO_KEY = {
    '7a': 'primary_care',
    '7d': 'specialist',
    '7b': 'chiropractic',
    '7c': 'occupational_therapy',
    '7i': 'physical_speech_therapy',
    '7f': 'podiatry',
    '7e1': 'mental_health_individual',
    '7e2': 'mental_health_group',
    '9c1': 'substance_abuse',
    '6': 'home_health',
    '8a1': 'diagnostic_procedures',
    '8a2': 'lab_services',
    '8b1': 'advanced_imaging',
    '8b3': 'xray',
    '9a1': 'outpatient_surgery_hospital',
    '9a2': 'outpatient_observation',
    '9b': 'outpatient_surgery_asc',
    '10a1': 'ambulance',
    '10a2': 'air_transportation',
    '11a': 'dme_prosthetics',
    '11c1': 'diabetic_supplies',
    '12': 'renal_dialysis',
    '15-2': 'partb_drugs',
}


def num(v):
    v = (v or '').strip()
    if v == '':
        return None
    try:
        return float(v)
    except ValueError:
        return None


def rows(path):
    with open(path, encoding='latin-1', newline='') as f:
        r = csv.reader(f, delimiter='\t')
        header = next(r)
        for row in r:
            yield dict(zip(header, row))


def key_of(d):
    return (d['pbp_a_hnumber'], d['pbp_a_plan_identifier'], str(int(d['segment_id'] or 0)))


def cost_entry(coins_yn, cmin, cmax, copay_yn, pmin, pmax):
    e = {}
    if coins_yn == '1':
        e['coins_min'] = num(cmin)
        e['coins_max'] = num(cmax) if num(cmax) is not None else num(cmin)
    if copay_yn == '1':
        e['copay_min'] = num(pmin)
        e['copay_max'] = num(pmax) if num(pmax) is not None else num(pmin)
    return e if any(v is not None for v in e.values()) else None


def ladder(d, prefix, kind, svc):
    """Day-interval ladder for inpatient (iha/iph) and SNF from Section C.
    kind = 'copay' | 'coins'; prefix = 'pbp_c_oon' | 'pbp_c_pos'."""
    unit = 'amt' if kind == 'copay' else 'pct'
    n = int(num(d.get(f'{prefix}_{kind}_{svc}_intrvl_num')) or 0)
    out = []
    for i in range(1, min(n, 3) + 1):
        val = num(d.get(f'{prefix}_{kind}_{svc}_{unit}_i{i}'))
        b = num(d.get(f'{prefix}_{kind}_{svc}_bgnd_i{i}'))
        e = num(d.get(f'{prefix}_{kind}_{svc}_endd_i{i}'))
        if val is None:
            continue
        step = {'from_day': int(b) if b is not None else None,
                'to_day': int(e) if e is not None else None}
        step['copay' if kind == 'copay' else 'coins'] = val
        out.append(step)
    return out


def facility(d, prefix, svc, mc_flag_svc=None):
    """Inpatient acute (iha), psych (iph) or SNF (snf) cost share."""
    e = {}
    if svc == 'snf':
        coins_yn = d.get(f'{prefix}_coins_snf_yn')
        copay_yn = d.get(f'{prefix}_copay_snf_yn')
        mc_coins = d.get(f'{prefix}_coins_snf_mc_cost_yn')
        mc_copay = d.get(f'{prefix}_copay_snf_mc_cost_yn')
    else:
        coins_yn = d.get(f'{prefix}_coins_ihs_yn')
        copay_yn = d.get(f'{prefix}_copay_ihs_yn')
        mc_coins = d.get(f'{prefix}_coins_{svc}_mc_cost_yn')
        mc_copay = d.get(f'{prefix}_copay_{svc}_mc_cost_yn')
    if mc_coins == '1' or mc_copay == '1':
        e['original_medicare_cost_share'] = True
    if coins_yn == '1':
        lad = ladder(d, prefix, 'coins', svc)
        flat = num(d.get(f'{prefix}_coins_{svc}_pct'))
        if lad:
            e['ladder'] = lad
        elif flat is not None:
            e['coins_min'] = e['coins_max'] = flat
    if copay_yn == '1':
        lad = ladder(d, prefix, 'copay', svc)
        flat_key = f'{prefix}_copay_{svc}_ps_amt' if svc != 'snf' else f'{prefix}_copay_snf_amt'
        flat = num(d.get(flat_key))
        if lad:
            e.setdefault('ladder', []).extend(lad)
            if svc != 'snf' and flat is not None and flat > 0:
                e['per_stay'] = flat
        elif flat is not None:
            if svc != 'snf':
                e['per_stay'] = flat
            else:
                e['copay_min'] = e['copay_max'] = flat
    return e or None


def main():
    pbp_dir, triples_path, out_path = sys.argv[1:4]
    wanted = set()
    with open(triples_path) as f:
        for line in f:
            line = line.strip()
            if line:
                c, p, s = line.split('|')
                wanted.add((c, p, str(int(s or 0))))

    plans = {}
    for d in rows(f'{pbp_dir}/pbp_Section_C.txt'):
        k = key_of(d)
        if k not in wanted:
            continue
        mode = 'none'
        prefix = None
        if d.get('pbp_c_oon_yn') == '1':
            mode, prefix = 'oon', 'pbp_c_oon'
        elif d.get('pbp_c_pos_yn') == '1':
            mode, prefix = 'pos', 'pbp_c_pos'
        costs = {}
        if prefix:
            for svc, keyname in (('iha', 'inpatient'), ('iph', 'mental_health_inpatient'), ('snf', 'snf')):
                f = facility(d, prefix, svc)
                if f:
                    costs[keyname] = f
        moop = None
        if mode == 'pos' and d.get('pbp_c_pos_maxenr_oopc_yn') == '1':
            moop = num(d.get('pbp_c_pos_maxenr_oopc_amt'))
        plans[k] = {'network_mode': mode, 'oon_moop': moop, 'costs': costs}

    def apply_outpatient(path, prefix, cats_cols):
        for d in rows(path):
            k = key_of(d)
            if k not in plans:
                continue
            cats = []
            for col in cats_cols:
                cats += [c for c in (d.get(col) or '').split(';') if c]
            if prefix == 'pbp_c_oon_outpt':
                e = cost_entry(d.get(f'{prefix}_coins_yn'), d.get(f'{prefix}_coins_min_pct'),
                               d.get(f'{prefix}_coins_max_pct'), d.get(f'{prefix}_copay_yn'),
                               d.get(f'{prefix}_copay_min_amt'), d.get(f'{prefix}_copay_max_amt'))
            else:
                e = cost_entry(d.get(f'{prefix}_coins_yn'), d.get(f'{prefix}_coins_min_pct'),
                               d.get(f'{prefix}_coins_max_pct'), d.get(f'{prefix}_copay_yn'),
                               d.get(f'{prefix}_copay_min_amt'), d.get(f'{prefix}_copay_max_amt'))
            if not e:
                continue
            for c in cats:
                kk = CODE_TO_KEY.get(c)
                if kk and kk not in plans[k]['costs']:
                    plans[k]['costs'][kk] = dict(e)

    apply_outpatient(f'{pbp_dir}/pbp_Section_C_OON.txt', 'pbp_c_oon_outpt',
                     ['pbp_c_oon_out_mc_bendesc_cats', 'pbp_c_oon_out_nmc_bendesc_cats'])
    apply_outpatient(f'{pbp_dir}/pbp_Section_C_POS.txt', 'pbp_c_pos_outpt',
                     ['pbp_c_pos_outpt_mc_bencats', 'pbp_c_pos_outpt_nmc_bencats'])

    out = []
    for (c, p, s), v in sorted(plans.items()):
        if v['network_mode'] == 'pos' and not v['costs']:
            pass
        out.append({'contract_id': c, 'plan_id': p, 'segment_id': s, **v})
    with open(out_path, 'w') as f:
        json.dump(out, f)
    modes = {}
    for o in out:
        modes[o['network_mode']] = modes.get(o['network_mode'], 0) + 1
    print(f'{len(out)} plans written; modes={modes}; missing={len(wanted) - len(out)}')


if __name__ == '__main__':
    main()
