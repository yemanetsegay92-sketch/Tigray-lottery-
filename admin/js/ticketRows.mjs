// Approved purchases contain an array of ticket numbers, but sale reports
// show ONE ROW PER ASSIGNED TICKET. Never create duplicate purchase documents
// or repeat the full purchase total as per-ticket revenue.
export const TICKET_HEADERS = Object.freeze([
  'Date', 'Name', 'Phone', 'Reference', 'Ticket Number',
  'Ticket Price (Birr)', 'Purchase Qty', 'Request ID'
]);

export function expandApprovedTicketRows(purchases) {
  const rows = [];
  let missingTicketRequests = 0;

  for (const purchase of purchases || []) {
    if (purchase.status !== 'approved') continue;
    const numbers = Array.isArray(purchase.ticketNumbers) ? purchase.ticketNumbers : [];
    if (!numbers.length) {
      missingTicketRequests++;
      continue; // No invented ticket numbers for incomplete/legacy records.
    }
    const qty = Number(purchase.quantity);
    const total = Number(purchase.total);
    const configuredPrice = Number(purchase.price);
    const price = Number.isFinite(configuredPrice) && configuredPrice > 0
      ? configuredPrice
      : (Number.isFinite(total) && Number.isFinite(qty) && qty > 0 ? total / qty : 0);
    const date = purchase.createdAt?.toDate
      ? purchase.createdAt.toDate().toLocaleString()
      : '';

    numbers.forEach((number, index) => {
      rows.push({
        requestId: String(purchase.id || ''),
        date,
        name: String(purchase.name || ''),
        phone: String(purchase.phone || ''),
        reference: String(purchase.reference || ''),
        // IDs remain strings to preserve leading zeroes in table/export.
        ticketNumber: String(number).padStart(6, '0'),
        price,
        purchaseQuantity: Number.isInteger(qty) && qty > 0 ? qty : numbers.length,
        firstInPurchase: index === 0
      });
    });
  }
  return { rows, missingTicketRequests };
}

export function ticketRowValues(row) {
  return [row.date, row.name, row.phone, row.reference,
    row.ticketNumber, row.price, row.purchaseQuantity, row.requestId];
}

export function ticketRowsToTsv(rows) {
  return [TICKET_HEADERS, ...rows.map(ticketRowValues)]
    .map(columns => columns.map(x => String(x ?? '').replace(/[\t\r\n]/g, ' ')).join('\t')).join('\n');
}

export function ticketRowsToCsv(rows) {
  const quote = value => '"' + String(value ?? '').replace(/[\r\n]/g, ' ').replace(/"/g, '""') + '"';
  return '\ufeff' + [TICKET_HEADERS, ...rows.map(ticketRowValues)]
    .map(columns => columns.map(quote).join(',')).join('\n');
}
