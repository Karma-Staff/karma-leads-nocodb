"use strict";
/* Spreadsheet parsing, off the main thread. The old server parsed xlsx
   synchronously in the request handler, so a big vendor workbook stalled
   every user's requests for the duration; worker_threads keeps the event
   loop free without dragging in a queue we don't need at this scale.

   In: { buffer, filename, category }
   Out: { records: [{kind, fields}], sheets, rows, detected, unmapped }
   — the same record shape the pipeline uploads, so the commit path in
   imports.js has exactly one format to process. */

const { parentPort, workerData } = require("worker_threads");
const XLSX = require("xlsx");
const { mapHeaders, rowToLead, pk, today, CATEGORIES } = require("./dedupe");

function parse({ buffer, filename, category }) {
  const cat = CATEGORIES.includes(category) ? category : "Other";
  const wb = XLSX.read(Buffer.from(buffer), { type: "buffer", cellDates: false, raw: false });
  if (!wb.SheetNames.length) throw new Error("that file has no sheets");

  // read every sheet — the vendor workbooks keep a "Review Queue" beside "Master"
  let raw = [], headers = [];
  for (const sheetName of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: null, raw: false });
    if (!rows.length) continue;
    raw = raw.concat(rows);
    for (const h of Object.keys(rows[0])) if (!headers.includes(h)) headers.push(h);
  }
  if (!raw.length) throw new Error("that file has no rows");

  const { map, phoneCols, isJob, unmapped } = mapHeaders(headers);
  if (!Object.keys(map).length && !phoneCols.length)
    throw new Error("no recognisable columns — expected headers like Company, Name, Email, Phone");

  const stamp = today();
  const records = [];
  for (const r of raw) {
    const l = rowToLead(r, map, phoneCols);
    if (!(l.company || l.name || l.email || l.phone)) continue;
    const common = {
      phone_key: pk(l.phone), source_file: filename,
      city: l.city, state: l.state, email: l.email, industry: l.industry,
      employees: l.employees,
    };
    if (isJob) {
      records.push({ kind: "job", fields: { ...common,
        name: l.jobTitle || l.title || "Job posting",
        company: l.company,
        contact: l.name !== l.company ? l.name : null,
        contact_title: l.title,
        job_url: l.jobUrl,
        source: "Job board",
        date_added: l.posted || stamp,
      } });
    } else if (l.name && l.company &&
               l.name.toLowerCase() !== l.company.toLowerCase()) {
      records.push({ kind: "person", fields: { ...common,
        name: l.name, company: l.company, title: l.title, phone: l.phone,
        category: cat, revenue: l.revenue,
        source: "Excel import", date_added: stamp,
      } });
    } else {
      records.push({ kind: "company", fields: { ...common,
        name: l.company || l.name, company: l.company || l.name,
        phone: l.phone, website: l.website,
        category: cat, revenue: l.revenue, certs: l.certs,
        source: "Excel import", date_added: stamp,
      } });
    }
  }
  return {
    records, sheets: wb.SheetNames, rows: raw.length,
    detected: isJob ? "job board export" : "lead list", unmapped,
  };
}

try {
  parentPort.postMessage({ ok: true, result: parse(workerData) });
} catch (e) {
  parentPort.postMessage({ ok: false, error: String(e.message || e) });
}
