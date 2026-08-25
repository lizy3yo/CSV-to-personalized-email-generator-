import 'dotenv/config'

/**
 * Background worker.
 *
 * Claims jobs from the `jobs` table with `SELECT ... FOR UPDATE SKIP LOCKED`,
 * processes them, and sleeps. Running it as a plain long-lived Node process is
 * what removes the serverless timeout ceiling from the architecture — there is
 * no function limit to design around and no external cron to depend on.
 *
 * Implemented in phase 4. This entry point exists now so `npm run worker`
 * reports honestly rather than failing with a missing-module error.
 */

console.log(`
  Worker — not implemented yet (phase 4).

  The jobs table and its claim index already exist; the loop that drains them
  arrives with batch generation. Until then there is nothing to process.

  Run 'npm run dev' for the app.
`)
