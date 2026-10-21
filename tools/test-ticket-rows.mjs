import assert from 'node:assert/strict';
import {
  TICKET_HEADERS, expandApprovedTicketRows, ticketRowsToCsv, ticketRowsToTsv
} from '../admin/js/ticketRows.mjs';

const date = { toDate: () => new Date('2026-10-21T16:00:00.000Z') };
const input = [
  {
    id: 'paymentA', status: 'approved', createdAt: date, name: 'Test Buyer',
    phone: '0912345678', reference: 'REF-01', quantity: 3, price: 100,
    total: 300, ticketNumbers: [100001, 100002, 100003]
  },
  {
    id: 'paymentB', status: 'approved', createdAt: date, name: 'Other',
    phone: '0900000000', reference: '', quantity: 1, total: 200,
    ticketNumbers: [43]
  },
  {
    id: 'paymentRejected', status: 'rejected', quantity: 3,
    ticketNumbers: [1, 2, 3]
  },
  {
    id: 'paymentC', status: 'approved', quantity: 1, total: 200,
    ticketNumbers: [] // Flag incomplete legacy approvals, don't invent numbers.
  }
];

const { rows, missingTicketRequests } = expandApprovedTicketRows(input);
assert.equal(rows.length, 4, '3 + 1 assigned tickets, not 2 approved purchases');
assert.equal(missingTicketRequests, 1);
assert.deepEqual(rows.map(r => r.ticketNumber), ['100001', '100002', '100003', '000043']);
assert.deepEqual(rows.map(r => r.name), ['Test Buyer', 'Test Buyer', 'Test Buyer', 'Other']);
assert.deepEqual(rows.map(r => r.price), [100, 100, 100, 200]);
assert.deepEqual(rows.map(r => r.purchaseQuantity), [3, 3, 3, 1]);
assert.deepEqual(rows.map(r => r.firstInPurchase), [true, false, false, true]);
assert.equal(rows.reduce((sum, r) => sum + r.price, 0), 500);
assert.equal(rows[0].requestId, rows[1].requestId);
assert.equal(rows[0].reference, rows[2].reference);
assert.equal(TICKET_HEADERS.length, 8);

const csv = ticketRowsToCsv(rows);
const tsv = ticketRowsToTsv(rows);
assert.equal(csv.trim().split('\n').length, 5); // header + four tickets
assert.equal(tsv.trim().split('\n').length, 5);
assert.match(csv, /"000043"/);
assert.match(tsv, /100001\t100\t3/);
const injection = expandApprovedTicketRows([
  { id:'x', status:'approved',name:'=SUM(1,2)',phone:'+251900001234',
    reference:'@evil',quantity:1,price:50,ticketNumbers:[20] }
]).rows;
assert.match(ticketRowsToCsv(injection), /"'=SUM\(1,2\)"/);
assert.match(ticketRowsToCsv(injection), /"'\+251900001234"/);
assert.match(ticketRowsToCsv(injection), /"'@evil"/);
assert.equal(expandApprovedTicketRows([{status:'pending',ticketNumbers:[2]}]).rows.length,0);
console.log('PASS: row per ticket, repeated buyer details, unit revenue, export formats, legacy safeguards');
