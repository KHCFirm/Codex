import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';

// pdfjs worker
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import workerSrc from 'pdfjs-dist/build/pdf.worker?url';
GlobalWorkerOptions.workerSrc = workerSrc;

export interface ServiceLine {
  cpt_code?: string;
  charge?: number;
  patient_responsibility?: number;
  insurance_paid?: number;
}

export interface ParseResult {
  doc_type: string;
  source_file: string;
  patient_name?: string;
  insured_id?: string;
  patient_address?: string;
  federal_tax_id?: string;
  billing_npi?: string;
  patient_dob?: string;
  eob_date?: string;
  claim_number?: string;
  service_lines?: ServiceLine[];
}

const HCFA_PATTERNS = [
  /CMS[-\s]?1500/i,
  /HCFA[-\s]?1500/i,
  /HCFA/i,
  /HEALTH\s+INSURANCE\s+CLAIM\s+FORM/i,
  /\b24J\b/i,
];

const EOB_PATTERNS = [
  /EXPLANATION\s+OF\s+BENEFITS/i,
  /REMITTANCE\s+ADVICE/i,
  /EXPLANATION\s+OF\s+PAYMENT/i,
  /\bEOB\b/i,
  /CLAIM\s+SUMMARY/i,
  /PATIENT\s+RESPONSIBILITY/i,
];

function classifyText(text: string): string {
  console.debug('classifyText start');
  for (const p of HCFA_PATTERNS) {
    if (p.test(text)) {
      console.debug('matched HCFA pattern', p);
      return 'HCFA';
    }
  }
  for (const p of EOB_PATTERNS) {
    if (p.test(text)) {
      console.debug('matched EOB pattern', p);
      return 'EOB';
    }
  }
  console.debug('classifyText no match');
  return 'UNKNOWN';
}

function parseMoney(value?: string): number | undefined {
  console.debug('parseMoney input', value);
  if (!value) return undefined;
  const cleaned = value.replace(/[^0-9.-]/g, '');
  const n = parseFloat(cleaned);
  const out = isNaN(n) ? undefined : n;
  console.debug('parseMoney result', out);
  return out;
}

function parseDate(value?: string): string | undefined {
  console.debug('parseDate input', value);
  if (!value) return undefined;
  const d = new Date(value);
  const out = isNaN(d.getTime()) ? undefined : d.toISOString().slice(0, 10);
  console.debug('parseDate result', out);
  return out;
}

export async function extractText(file: File): Promise<string> {
  console.debug('extractText start', file.name);
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await getDocument({ data: arrayBuffer }).promise;
  let text = '';
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const strings = content.items.map((item: any) => item.str as string);
    console.debug('extractText page', i, 'items', strings.length);
    text += strings.join(' ') + '\n';
  }
  console.debug('extractText length', text.length);
  return text;
}

function find(pattern: RegExp, text: string): string | undefined {
  const m = text.match(pattern);
  return m ? m[1].trim() : undefined;
}

function parseHcfa(text: string): Partial<ParseResult> {
  console.debug('parseHcfa start');
  const result: Partial<ParseResult> = { doc_type: 'HCFA' };
  const fields: Record<string, RegExp> = {
    patient_name: /PATIENT'S NAME[^\n]*\n(.+)/i,
    insured_id: /1A\.\s*INSURED'S ID NUMBER[^\n]*\n(.+)/i,
    patient_address: /5\.\s*PATIENT ADDRESS[^\n]*\n(.+)/i,
    federal_tax_id: /25\.\s*FEDERAL TAX ID NUMBER[^\n]*\n(.+)/i,
    billing_npi: /33A\.\s*NPI[^\n]*\n(.+)/i,
  };
  for (const [k, p] of Object.entries(fields)) {
    const val = find(p, text);
    if (val) {
      console.debug('parseHcfa field', k, val);
      (result as any)[k] = val;
    }
  }
  const dob = find(/3\.\s*DATE OF BIRTH[^\n]*\n(.+)/i, text);
  if (dob) result.patient_dob = parseDate(dob);
  result.service_lines = parseServiceLinesHcfa(text);
  console.debug('parseHcfa service lines', result.service_lines.length);
  return result;
}

function parseServiceLinesHcfa(text: string): ServiceLine[] {
  const header = text.search(/24A.*24B.*24D.*24F.*24J/i);
  if (header === -1) return [];
  const body = text.slice(header).split(/\n/).slice(1);
  const lines: ServiceLine[] = [];
  for (const raw of body) {
    const cols = raw.trim().split(/\s+/);
    if (cols.length < 4) continue;
    lines.push({
      cpt_code: cols[2],
      charge: parseMoney(cols[3]),
    });
  }
  console.debug('parseServiceLinesHcfa lines', lines.length);
  return lines;
}

function parseEob(text: string): Partial<ParseResult> {
  console.debug('parseEob start');
  const result: Partial<ParseResult> = { doc_type: 'EOB' };
  const date = find(/(?:Payment|Check|Printed) Date\s*[:\-]?\s*([^\n]+)/i, text);
  if (date) {
    result.eob_date = parseDate(date);
    console.debug('parseEob date', result.eob_date);
  }
  const claim = find(/CLAIM NUMBER[:\s]*([A-Z0-9-]+)/i, text);
  if (claim) {
    result.claim_number = claim;
    console.debug('parseEob claim', claim);
  }
  result.service_lines = parseServiceLinesEob(text);
  console.debug('parseEob service lines', result.service_lines.length);
  return result;
}

function parseServiceLinesEob(text: string): ServiceLine[] {
  const header = text.search(/CPT\s+CODE/i);
  if (header === -1) return [];
  const body = text.slice(header).split(/\n/).slice(1);
  const lines: ServiceLine[] = [];
  for (const raw of body) {
    const cols = raw.trim().split(/\s+/);
    if (cols.length < 4) continue;
    lines.push({
      cpt_code: cols[0],
      charge: parseMoney(cols[1]),
      patient_responsibility: parseMoney(cols[2]),
      insurance_paid: parseMoney(cols[3]),
    });
  }
  console.debug('parseServiceLinesEob lines', lines.length);
  return lines;
}

export async function parseFile(file: File): Promise<ParseResult> {
  console.debug('parseFile start', file.name);
  const text = await extractText(file);
  const docType = classifyText(text);
  console.debug('parseFile docType', docType);
  let result: Partial<ParseResult> = { doc_type: docType };
  if (docType === 'HCFA') result = { ...result, ...parseHcfa(text) };
  else if (docType === 'EOB') result = { ...result, ...parseEob(text) };
  const final = { ...(result as ParseResult), source_file: file.name };
  console.debug('parseFile result keys', Object.keys(final));
  return final;
}
