// Individual purchase alerts to admins are disabled by design.
// Lottery admins review pending purchases in the authenticated dashboard;
// Telegram is reserved primarily for buyer decision notifications.
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(410).json({
    ok: false,
    error: 'Per-purchase admin Telegram alerts are disabled. Open the lottery admin dashboard.'
  });
};
