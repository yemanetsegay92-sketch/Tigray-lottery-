import { db } from './firebase.js';

import {
  collection,
  getDocs,
  query,
  where,
  doc,
  getDoc,
  addDoc,
  serverTimestamp
} from 'https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js';


const esc = s =>
  String(s || '').replace(/[&<>"]/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;'
  }[c]));


const qs = new URLSearchParams(location.search);


/* =========================================================
   HOME PAGE
========================================================= */

async function home() {

  const list = document.getElementById('lotteryList');

  // Safety check
  if (!list) {
    console.error('lotteryList element not found.');
    return;
  }

  try {

    const snap = await getDocs(
      collection(db, 'lotteries')
    );

    const lots = snap.docs
      .map(d => ({
        id: d.id,
        ...d.data()
      }))
      .filter(x => x.status !== 'hidden');


    list.innerHTML = lots.length
      ? lots.map(x => `

        <article class="card">

          <div class="status ${x.status}">
            ${String(x.status || '').toUpperCase()}
          </div>

          <h2>${esc(x.name)}</h2>

          <p>
            Ticket:
            <b>${x.price} Birr</b>
          </p>

          <p>
            Number range:
            ${x.min} – ${x.max}
          </p>

          ${
            x.status === 'active'

              ? `<a class="btn"
                    href="buy.html?lot=${encodeURIComponent(x.id)}">
                    Buy Ticket
                  </a>`

              : `<button disabled>
                  ${
                    x.status === 'upcoming'
                      ? 'Coming Soon'
                      : 'Closed'
                  }
                 </button>`
          }

        </article>

      `).join('')

      : `
        <p class="empty">
          No lotteries available yet.
        </p>
      `;

  } catch (e) {

    console.error(e);

    list.innerHTML = `
      <p class="empty">
        Unable to load lotteries.
        Check Firebase configuration and rules.
      </p>
    `;

  }

}


/* =========================================================
   BUY PAGE
========================================================= */

async function buy() {

  const id = qs.get('lot');

  const info = document.getElementById('lotteryInfo');
  const buyForm = document.getElementById('buyForm');
  const message = document.getElementById('message');


  // Safety checks

  if (!info || !buyForm || !message) {

    console.error(
      'Buy page elements missing.',
      {
        info,
        buyForm,
        message
      }
    );

    return;

  }


  if (!id) {

    info.innerHTML = `
      <div class="card">

        <h2>No lottery selected</h2>

        <a class="btn" href="index.html">
          Go back
        </a>

      </div>
    `;

    buyForm.style.display = 'none';

    return;

  }


  try {

    const snap = await getDoc(
      doc(db, 'lotteries', id)
    );


    if (
      !snap.exists() ||
      snap.data().status !== 'active'
    ) {

      info.innerHTML = `
        <div class="card">

          <h2>Lottery unavailable</h2>

          <a class="btn" href="index.html">
            Go back
          </a>

        </div>
      `;

      buyForm.style.display = 'none';

      return;

    }


    const lot = {
      id: snap.id,
      ...snap.data()
    };


    info.innerHTML = `

      <div class="card">

        <h2>${esc(lot.name)}</h2>

        <p>
          Ticket price:
          <b>${lot.price} Birr</b>
        </p>

        <label>How many tickets?</label>

        <input
          id="quantity"
          type="number"
          min="1"
          value="1"
        >

        <p id="total">
          <b>
            Total: ${lot.price} Birr
          </b>
        </p>

      </div>

    `;


    const quantityInput =
      document.getElementById('quantity');

    const totalElement =
      document.getElementById('total');


    quantityInput.addEventListener(
      'input',
      () => {

        const quantity =
          Number(quantityInput.value || 0);

        const total =
          quantity * Number(lot.price);


        totalElement.innerHTML = `
          <b>
            Total: ${total} Birr
          </b>
        `;

      }
    );


    /* =====================================================
       SUBMIT PURCHASE
    ===================================================== */

    buyForm.addEventListener(
      'submit',
      async e => {

        e.preventDefault();


        const name =
          document.getElementById('name')
            .value
            .trim();


        const phone =
          document.getElementById('phone')
            .value
            .trim();


        const reference =
          document.getElementById('reference')
            .value
            .trim();


        const quantity =
          Number(quantityInput.value || 1);


        if (quantity < 1) {

          alert(
            'Choose at least one ticket.'
          );

          return;

        }


        if (!reference) {

          alert(
            'Please enter your payment reference number.'
          );

          return;

        }


        try {

          /* ===============================================
             CHECK DUPLICATE PAYMENT REFERENCE
          =============================================== */

          const dup = await getDocs(

            query(
              collection(db, 'ticketRequests'),

              where(
                'reference',
                '==',
                reference
              )
            )

          );


          if (!dup.empty) {

            alert(
              'This payment reference was already submitted.'
            );

            return;

          }


          /* ===============================================
             SAVE REQUEST
          =============================================== */

          await addDoc(

            collection(db, 'ticketRequests'),

            {

              lotteryId: lot.id,

              name,

              phone,

              reference,

              quantity,

              price: Number(lot.price),

              total:
                Number(lot.price) *
                quantity,

              status: 'pending',

              ticketNumbers: [],

              createdAt:
                serverTimestamp()

            }

          );


          buyForm.style.display = 'none';


          message.innerHTML = `

            <div class="message">

              <h3>
                ✅ Submitted successfully
              </h3>

              <p>
                Your payment is pending
                manual approval.
              </p>

              <p>
                Tickets requested:
                <b>${quantity}</b>
              </p>

              <p>
                Total paid:
                <b>
                  ${Number(lot.price) * quantity}
                  Birr
                </b>
              </p>

              <a
                class="btn"
                href="index.html"
              >
                Back Home
              </a>

            </div>

          `;


        } catch (err) {

          console.error(err);

          alert(
            'Unable to submit your ticket request. Please try again.'
          );

        }

      }
    );


  } catch (err) {

    console.error(err);

    info.innerHTML = `

      <div class="card">

        <h2>Error loading lottery</h2>

        <p>
          Please try again later.
        </p>

        <a class="btn" href="index.html">
          Go back
        </a>

      </div>

    `;

    buyForm.style.display = 'none';

  }

}


/* =========================================================
   START CORRECT PAGE
========================================================= */

// Much safer than checking the URL path alone.

if (document.getElementById('buyForm')) {

  buy();

} else if (document.getElementById('lotteryList')) {

  home();

} else {

  console.error(
    'Unknown page: required page elements not found.'
  );

}