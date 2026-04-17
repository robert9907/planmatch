export const BROKER = {
  name: 'Rob Simm',
  license: 'NC #10447418',
  npn: '10447418',
  phone: '(828) 761-3326',
  email: 'robert@generationhealth.me',
  calendly: 'calendly.com/robert-generationhealth/new-meeting',
  sunfire:
    'https://www.sunfirematrix.com/app/consumer/medicareadvocates/10447418/#/',
  address: '2731 Meridian Pkwy, Durham NC 27713',
  states: ['NC', 'TX', 'GA'] as const,
};

export const MEDICARE_2026 = {
  partB_premium: 202.9,
  partB_deductible: 283,
  partA_deductible: 1736,
  partD_oop_cap: 2100,
  ma_oop_max: 9350,
  insulin_cap: 35,
  hd_plan_g_deductible: 2870,
  msp_income_limit: 1816,
  lis_income_limit: 22590,
};

export const WORKFLOW_STEPS = [
  { id: 1, key: 'client', label: 'Client Lookup' },
  { id: 2, key: 'intake', label: 'Intake' },
  { id: 3, key: 'meds', label: 'Medications' },
  { id: 4, key: 'providers', label: 'Providers' },
  { id: 5, key: 'filters', label: 'Benefit Filters' },
  { id: 6, key: 'quote', label: 'Quote & Delivery' },
] as const;
