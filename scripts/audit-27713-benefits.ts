import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';

if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)([^"\n]*)\2$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[3];
  }
}

const url = process.env.SUPABASE_URL ?? '';
const key =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  process.env.SUPABASE_ANON_KEY ??
  '';
if (!url || !key) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY/ANON_KEY');
  process.exit(1);
}
const sb = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function main() {
  // Step 1: Get all plans available in Durham County (27713)
  console.log('\n=== ALL PLANS IN DURHAM COUNTY (27713) ===');
  const { data: plans } = await sb
    .from('pm_plans')
    .select('contract_id, plan_id, plan_name, carrier, plan_type, monthly_premium, star_rating')
    .eq('state', 'NC')
    .ilike('county_name', '%Durham%')
    .order('carrier')
    .order('plan_name');
  
  if (!plans || plans.length === 0) {
    console.log('No plans found for Durham County');
    return;
  }
  
  console.log(`Found ${plans.length} plans\n`);

  // Step 2: For each plan, count benefit categories
  for (const p of plans) {
    const { data: benefits } = await sb
      .from('pm_plan_benefits')
      .select('benefit_category, copay, coinsurance')
      .eq('contract_id', p.contract_id)
      .eq('plan_id', p.plan_id);
    
    const cats = benefits?.map(b => b.benefit_category).sort() ?? [];
    const hasMedical = cats.some(c => 
      ['primary_care','specialist','urgent_care','emergency','inpatient',
       'outpatient_surgery','lab','imaging','xray'].includes(c)
    );
    
    const { data: pbp } = await sb
      .from('pbp_benefits')
      .select('benefit_type')
      .in('plan_id', [
        `${p.contract_id}-${p.plan_id}`,
        `${p.contract_id}-${p.plan_id}-0`,
        `${p.contract_id}-${p.plan_id}-000`
      ]);
    
    const pbpTypes = [...new Set(pbp?.map(b => b.benefit_type) ?? [])].sort();
    
    console.log(`${p.carrier} | ${p.plan_name} (${p.plan_type}) | ${p.contract_id}-${p.plan_id}`);
    console.log(`  Premium: $${p.monthly_premium}/mo | Stars: ${p.star_rating}`);
    console.log(`  pm_plan_benefits: ${cats.length} categories ${hasMedical ? '✓ HAS MEDICAL' : '✗ NO MEDICAL'}`);
    console.log(`    Categories: ${cats.join(', ') || 'NONE'}`);
    console.log(`  pbp_benefits: ${pbpTypes.length} types`);
    console.log(`    Types: ${pbpTypes.join(', ') || 'NONE'}`);
    console.log('');
  }
}

main().catch(console.error);
