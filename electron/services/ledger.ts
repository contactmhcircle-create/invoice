import type { Db } from '../db/connection.js';
import { newId } from '../db/connection.js';
import { recordAudit } from '../db/audit.js';
import { nowInstant, today } from '../../shared/dates.js';
import type { IsoDate } from '../../shared/dates.js';

/**
 * Lightweight double-entry ledger.
 *
 * This exists so the app can show true margin and produce a self-contained
 * enquiry pack. It is deliberately NOT a replacement for Tide — Cerviz's books
 * live there, and two sets of books that disagree are worse than one. This
 * ledger reconciles to Tide via the bank import.
 *
 * Journals are never edited. Corrections are posted as reversing journals, which
 * is both correct accounting practice and the only thing that survives scrutiny.
 */

export interface JournalLineInput {
  accountCode: string;
  debitPence?: number;
  creditPence?: number;
  description?: string;
}

export function postJournal(
  db: Db,
  input: {
    date: IsoDate;
    narrative: string;
    lines: JournalLineInput[];
    sourceType?: string;
    sourceId?: string;
  },
): string {
  const debits = input.lines.reduce((a, l) => a + (l.debitPence ?? 0), 0);
  const credits = input.lines.reduce((a, l) => a + (l.creditPence ?? 0), 0);

  if (debits !== credits) {
    throw new Error(
      `Journal does not balance: debits ${(debits / 100).toFixed(2)} vs credits ${(credits / 100).toFixed(2)}.`,
    );
  }
  if (debits === 0) throw new Error('Journal has no value.');

  const id = newId('jnl');
  const now = nowInstant();

  db.prepare(
    `INSERT INTO journals (id, journal_date, narrative, source_type, source_id, created_at, created_by)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(id, input.date, input.narrative, input.sourceType ?? null, input.sourceId ?? null, now,
        process.env.USER ?? 'operator');

  const insert = db.prepare(
    `INSERT INTO journal_lines (id, journal_id, account_code, debit_pence, credit_pence, description)
     VALUES (?,?,?,?,?,?)`,
  );
  for (const l of input.lines) {
    insert.run(newId('jl'), id, l.accountCode, l.debitPence ?? 0, l.creditPence ?? 0, l.description ?? null);
  }

  return id;
}

/** Posts an equal and opposite journal. The original stays in the record. */
export function reverseJournal(db: Db, journalId: string, reason: string): string {
  const original = db.prepare('SELECT * FROM journals WHERE id = ?').get(journalId) as any;
  if (!original) throw new Error('Journal not found');
  if (original.reversed_by) throw new Error('This journal has already been reversed.');

  const lines = db.prepare('SELECT * FROM journal_lines WHERE journal_id = ?').all(journalId) as any[];

  const reversalId = postJournal(db, {
    date: today(),
    narrative: `Reversal of ${original.narrative} — ${reason}`,
    sourceType: 'reversal',
    sourceId: journalId,
    lines: lines.map((l) => ({
      accountCode: l.account_code,
      debitPence: l.credit_pence,
      creditPence: l.debit_pence,
      description: l.description,
    })),
  });

  db.prepare('UPDATE journals SET reversed_by = ? WHERE id = ?').run(reversalId, journalId);
  db.prepare('UPDATE journals SET reverses = ? WHERE id = ?').run(journalId, reversalId);

  recordAudit(db, {
    entityType: 'journal',
    entityId: journalId,
    action: 'reversed',
    summary: `Journal reversed: ${reason}`,
    after: { reversalId },
  });

  return reversalId;
}

// ---------------------------------------------------------------------------
// Automatic postings
// ---------------------------------------------------------------------------

export function postInvoice(db: Db, invoiceId: string): string | null {
  const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId) as any;
  if (!inv || inv.status === 'draft') return null;

  const existing = db
    .prepare(`SELECT id FROM journals WHERE source_type = 'invoice' AND source_id = ?`)
    .get(invoiceId) as any;
  if (existing) return existing.id;

  const lines: JournalLineInput[] = [
    { accountCode: '1100', debitPence: inv.base_gross_pence, description: `Invoice ${inv.number}` },
    { accountCode: '4000', creditPence: inv.base_net_pence, description: 'Staffing services' },
  ];
  if (inv.base_vat_pence > 0) {
    lines.push({ accountCode: '2200', creditPence: inv.base_vat_pence, description: 'Output VAT' });
  }

  return postJournal(db, {
    date: inv.issue_date,
    narrative: `Invoice ${inv.number}`,
    lines,
    sourceType: 'invoice',
    sourceId: invoiceId,
  });
}

export function postCreditNote(db: Db, creditNoteId: string): string | null {
  const cn = db.prepare('SELECT * FROM credit_notes WHERE id = ?').get(creditNoteId) as any;
  if (!cn || cn.status === 'draft') return null;

  const existing = db
    .prepare(`SELECT id FROM journals WHERE source_type = 'credit_note' AND source_id = ?`)
    .get(creditNoteId) as any;
  if (existing) return existing.id;

  const baseNet = Math.round(cn.net_pence * cn.fx_rate);
  const baseVat = Math.round(cn.vat_pence * cn.fx_rate);
  const baseGross = baseNet + baseVat;

  const lines: JournalLineInput[] = [
    { accountCode: '4000', debitPence: baseNet, description: `Credit note ${cn.number}` },
    { accountCode: '1100', creditPence: baseGross, description: `Credit note ${cn.number}` },
  ];
  if (baseVat > 0) lines.push({ accountCode: '2200', debitPence: baseVat, description: 'Output VAT reversed' });

  return postJournal(db, {
    date: cn.issue_date,
    narrative: `Credit note ${cn.number}`,
    lines,
    sourceType: 'credit_note',
    sourceId: creditNoteId,
  });
}

export function postPaymentReceipt(db: Db, paymentId: string): string | null {
  const p = db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId) as any;
  if (!p) return null;

  const existing = db
    .prepare(`SELECT id FROM journals WHERE source_type = 'payment' AND source_id = ?`)
    .get(paymentId) as any;
  if (existing) return existing.id;

  const base = Math.round(p.amount_pence * p.fx_rate);

  // Where the money landed in a director's personal account first, it is routed
  // through the director's loan account so the two-step movement is explicit in
  // the books rather than looking like a direct receipt.
  const cashAccount = p.via_director_loan ? '1210' : '1200';

  if (p.direction === 'in') {
    return postJournal(db, {
      date: p.paid_on,
      narrative: p.via_director_loan
        ? 'Receipt via director’s personal account'
        : 'Customer receipt',
      lines: [
        { accountCode: cashAccount, debitPence: base, description: p.reference ?? '' },
        { accountCode: '1100', creditPence: base, description: 'Trade debtors' },
      ],
      sourceType: 'payment',
      sourceId: paymentId,
    });
  }

  return postJournal(db, {
    date: p.paid_on,
    narrative: 'Supplier payment',
    lines: [
      { accountCode: '2100', debitPence: base, description: 'Trade creditors' },
      { accountCode: '1200', creditPence: base, description: p.reference ?? '' },
    ],
    sourceType: 'payment',
    sourceId: paymentId,
  });
}

export function postPurchaseInvoice(db: Db, purchaseInvoiceId: string): string | null {
  const pi = db.prepare('SELECT * FROM purchase_invoices WHERE id = ?').get(purchaseInvoiceId) as any;
  if (!pi || pi.status === 'void') return null;

  const existing = db
    .prepare(`SELECT id FROM journals WHERE source_type = 'purchase_invoice' AND source_id = ?`)
    .get(purchaseInvoiceId) as any;
  if (existing) return existing.id;

  const baseNet = Math.round(pi.net_pence * pi.fx_rate);
  const baseVat = Math.round(pi.vat_pence * pi.fx_rate);
  const baseGross = baseNet + baseVat;

  const expenseAccount =
    pi.category === 'umbrella_labour' ? '5000'
      : pi.category === 'paye_labour' ? '5010'
      : pi.category === 'compliance' ? '6100'
      : '6000';

  const lines: JournalLineInput[] = [
    { accountCode: expenseAccount, debitPence: baseNet, description: `Purchase ${pi.our_reference}` },
    { accountCode: '2100', creditPence: baseGross, description: `Purchase ${pi.our_reference}` },
  ];
  if (baseVat > 0) lines.push({ accountCode: '2200', debitPence: baseVat, description: 'Input VAT' });

  return postJournal(db, {
    date: pi.invoice_date,
    narrative: `Purchase invoice ${pi.our_reference}`,
    lines,
    sourceType: 'purchase_invoice',
    sourceId: purchaseInvoiceId,
  });
}

/**
 * Holiday pay accrues as a liability as the worker earns it, rather than landing
 * as a surprise when it is taken.
 */
export function postHolidayAccrual(db: Db, timesheetId: string, accrualPence: number): string | null {
  if (accrualPence <= 0) return null;
  const ts = db.prepare('SELECT * FROM timesheets WHERE id = ?').get(timesheetId) as any;
  if (!ts) return null;

  const existing = db
    .prepare(`SELECT id FROM journals WHERE source_type = 'holiday_accrual' AND source_id = ?`)
    .get(timesheetId) as any;
  if (existing) return existing.id;

  return postJournal(db, {
    date: ts.week_ending,
    narrative: `Holiday pay accrual — timesheet ${ts.reference}`,
    lines: [
      { accountCode: '5030', debitPence: accrualPence, description: 'Holiday pay' },
      { accountCode: '2220', creditPence: accrualPence, description: 'Holiday pay accrual' },
    ],
    sourceType: 'holiday_accrual',
    sourceId: timesheetId,
  });
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

export function trialBalance(db: Db, asOf: IsoDate = today()) {
  const rows = db
    .prepare(
      `SELECT a.code, a.name, a.type,
              COALESCE(SUM(jl.debit_pence),0) AS debits,
              COALESCE(SUM(jl.credit_pence),0) AS credits
       FROM accounts a
       LEFT JOIN journal_lines jl ON jl.account_code = a.code
       LEFT JOIN journals j ON j.id = jl.journal_id AND j.journal_date <= ?
       GROUP BY a.code
       ORDER BY a.code`,
    )
    .all(asOf) as any[];

  const accounts = rows.map((r) => {
    const net = r.debits - r.credits;
    return {
      code: r.code,
      name: r.name,
      type: r.type,
      debitsPence: r.debits,
      creditsPence: r.credits,
      balancePence: net,
      // Assets and expenses sit as debits; liabilities, equity and income as credits.
      displayPence: r.type === 'asset' || r.type === 'expense' ? net : -net,
    };
  });

  const totalDebits = accounts.reduce((a, r) => a + r.debitsPence, 0);
  const totalCredits = accounts.reduce((a, r) => a + r.creditsPence, 0);

  return {
    asOf,
    accounts: accounts.filter((a) => a.debitsPence !== 0 || a.creditsPence !== 0),
    totalDebitsPence: totalDebits,
    totalCreditsPence: totalCredits,
    balanced: totalDebits === totalCredits,
  };
}

export function profitAndLoss(db: Db, from: IsoDate, to: IsoDate) {
  const rows = db
    .prepare(
      `SELECT a.code, a.name, a.type,
              COALESCE(SUM(jl.credit_pence),0) - COALESCE(SUM(jl.debit_pence),0) AS net
       FROM accounts a
       JOIN journal_lines jl ON jl.account_code = a.code
       JOIN journals j ON j.id = jl.journal_id
       WHERE a.type IN ('income','expense') AND j.journal_date BETWEEN ? AND ?
       GROUP BY a.code
       ORDER BY a.code`,
    )
    .all(from, to) as any[];

  const income = rows.filter((r) => r.type === 'income').map((r) => ({ ...r, amountPence: r.net }));
  const costOfSales = rows
    .filter((r) => r.type === 'expense' && r.code.startsWith('5'))
    .map((r) => ({ ...r, amountPence: -r.net }));
  const overheads = rows
    .filter((r) => r.type === 'expense' && r.code.startsWith('6'))
    .map((r) => ({ ...r, amountPence: -r.net }));

  const totalIncome = income.reduce((a, r) => a + r.amountPence, 0);
  const totalCostOfSales = costOfSales.reduce((a, r) => a + r.amountPence, 0);
  const totalOverheads = overheads.reduce((a, r) => a + r.amountPence, 0);
  const grossProfit = totalIncome - totalCostOfSales;

  return {
    from,
    to,
    income,
    costOfSales,
    overheads,
    totalIncomePence: totalIncome,
    totalCostOfSalesPence: totalCostOfSales,
    grossProfitPence: grossProfit,
    grossMarginPercent: totalIncome > 0 ? Math.round((grossProfit / totalIncome) * 1000) / 10 : 0,
    totalOverheadsPence: totalOverheads,
    netProfitPence: grossProfit - totalOverheads,
  };
}

export function balanceSheet(db: Db, asOf: IsoDate = today()) {
  const tb = trialBalance(db, asOf);
  const assets = tb.accounts.filter((a) => a.type === 'asset');
  const liabilities = tb.accounts.filter((a) => a.type === 'liability');
  const equity = tb.accounts.filter((a) => a.type === 'equity');

  const totalAssets = assets.reduce((a, r) => a + r.displayPence, 0);
  const totalLiabilities = liabilities.reduce((a, r) => a + r.displayPence, 0);
  const totalEquity = equity.reduce((a, r) => a + r.displayPence, 0);

  // Income less expenses to date is retained profit not yet closed to reserves.
  const retained = tb.accounts
    .filter((a) => a.type === 'income' || a.type === 'expense')
    .reduce((a, r) => a + r.displayPence, 0);

  return {
    asOf,
    assets,
    liabilities,
    equity,
    totalAssetsPence: totalAssets,
    totalLiabilitiesPence: totalLiabilities,
    totalEquityPence: totalEquity,
    retainedProfitPence: retained,
    netAssetsPence: totalAssets - totalLiabilities,
  };
}
