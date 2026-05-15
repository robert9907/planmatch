// scripts/enrich-pm-provider-directory.mjs
//
// Backfill stub rows in pm_provider_directory (those missing last_name)
// with name, credentials, primary address from the NPPES public registry.
//
// Run: DATABASE_URL='...' node scripts/enrich-pm-provider-directory.mjs
//
// The directory table was being created as NPI-only stubs when a provider
// got cached in pm_provider_network_cache without going through the
// NPPES enrichment path. This restores the missing fields so the UI's
// name-based provider search can find them.

import pg from 'pg';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL not set');
  process.exit(1);
}

const NPPES_URL = 'https://npiregistry.cms.hhs.gov/api/?version=2.1&number=';
const CONCURRENCY = 20;
const BATCH_LOG = 100;

function titleCase(s) {
  if (!s) return s;
  return s
    .toLowerCase()
    .split(/(\s+|-)/)
    .map((tok) => (/^[A-Za-z]/.test(tok) ? tok.charAt(0).toUpperCase() + tok.slice(1) : tok))
    .join('');
}

function pickLocationAddress(addresses) {
  if (!Array.isArray(addresses)) return null;
  return (
    addresses.find((a) => a?.address_purpose === 'LOCATION') ??
    addresses.find((a) => a?.address_purpose === 'PRIMARY') ??
    addresses[0] ??
    null
  );
}

function pickPrimaryTaxonomy(taxonomies) {
  if (!Array.isArray(taxonomies)) return null;
  return taxonomies.find((t) => t?.primary) ?? taxonomies[0] ?? null;
}

function parseNppes(result) {
  if (!result || result.enumeration_type === 'NPI-2') {
    // Organization — leave a usable display_name, no person fields.
    const orgName = result?.basic?.organization_name ?? null;
    const loc = pickLocationAddress(result?.addresses);
    const tax = pickPrimaryTaxonomy(result?.taxonomies);
    return {
      isOrg: true,
      first_name: null,
      last_name: null,
      display_name: orgName ? titleCase(orgName) : null,
      credentials: null,
      specialties: tax?.desc ?? null,
      primary_address: loc?.address_1 ? titleCase(loc.address_1) : null,
      primary_city: loc?.city ? titleCase(loc.city) : null,
      primary_state: loc?.state ?? null,
    };
  }
  const b = result?.basic ?? {};
  const first = b.first_name ? titleCase(b.first_name) : null;
  const middle = b.middle_name ? titleCase(b.middle_name) : null;
  const last = b.last_name ? titleCase(b.last_name) : null;
  const cred = b.credential ? b.credential.replace(/\s+/g, ' ').trim() : null;
  const display = [first, middle, last].filter(Boolean).join(' ') +
    (cred ? `, ${cred}` : '');
  const loc = pickLocationAddress(result?.addresses);
  const tax = pickPrimaryTaxonomy(result?.taxonomies);
  return {
    isOrg: false,
    first_name: first,
    last_name: last,
    display_name: display || null,
    credentials: cred,
    specialties: tax?.desc ?? null,
    primary_address: loc?.address_1 ? titleCase(loc.address_1) : null,
    primary_city: loc?.city ? titleCase(loc.city) : null,
    primary_state: loc?.state ?? null,
  };
}

async function fetchOne(npi) {
  const res = await fetch(`${NPPES_URL}${npi}`);
  if (!res.ok) throw new Error(`nppes ${npi} → ${res.status}`);
  const body = await res.json();
  if (!body || body.result_count !== 1 || !Array.isArray(body.results)) return null;
  return parseNppes(body.results[0]);
}

async function runPool(items, worker, concurrency) {
  let cursor = 0;
  const next = async () => {
    while (cursor < items.length) {
      const i = cursor++;
      await worker(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, next));
}

async function main() {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();

  console.log('Loading stub NPIs...');
  const { rows } = await client.query(
    `select npi from pm_provider_directory where last_name is null order by npi;`,
  );
  console.log(`Found ${rows.length} stubs to enrich.`);

  if (rows.length === 0) {
    await client.end();
    return;
  }

  let processed = 0;
  let updated = 0;
  const notFound = [];
  const errored = [];
  const startedAt = Date.now();

  await runPool(
    rows,
    async ({ npi }) => {
      try {
        const data = await fetchOne(npi);
        if (!data) {
          notFound.push(npi);
        } else {
          await client.query(
            `update pm_provider_directory
                set first_name      = coalesce($2, first_name),
                    last_name       = coalesce($3, last_name),
                    display_name    = coalesce($4, display_name),
                    credentials     = coalesce($5, credentials),
                    specialties     = coalesce($6, specialties),
                    primary_address = coalesce($7, primary_address),
                    primary_city    = coalesce($8, primary_city),
                    primary_state   = coalesce($9, primary_state),
                    updated_at      = now()
              where npi = $1;`,
            [
              npi,
              data.first_name,
              data.last_name,
              data.display_name,
              data.credentials,
              data.specialties,
              data.primary_address,
              data.primary_city,
              data.primary_state,
            ],
          );
          updated++;
        }
      } catch (err) {
        errored.push({ npi, error: String(err?.message ?? err) });
      } finally {
        processed++;
        if (processed % BATCH_LOG === 0) {
          const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
          const rate = (processed / Number(elapsed)).toFixed(1);
          console.log(
            `[${processed}/${rows.length}] updated=${updated} not_found=${notFound.length} errors=${errored.length} elapsed=${elapsed}s rate=${rate}/s`,
          );
        }
      }
    },
    CONCURRENCY,
  );

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log('\n--- DONE ---');
  console.log(`Processed: ${processed}`);
  console.log(`Updated:   ${updated}`);
  console.log(`Not found: ${notFound.length}`);
  console.log(`Errors:    ${errored.length}`);
  console.log(`Elapsed:   ${elapsed}s`);

  if (notFound.length > 0) {
    console.log('\nNPIs NPPES had no record for:');
    console.log(notFound.join('\n'));
  }
  if (errored.length > 0) {
    console.log('\nNPIs that errored:');
    for (const e of errored) console.log(`${e.npi}\t${e.error}`);
  }

  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
