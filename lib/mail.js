// Sending mail.
//
// One mailbox, named in the hosting environment, and nothing about it kept in
// the database. Whoever is in charge of payslips — HR or the operations
// manager — connects their own mailbox by pasting two values into Vercel:
//
//   MAIL_USER   the address it is sent from, e.g. hr@msbeauave.com
//   MAIL_PASS   an app password for that mailbox, not the sign-in password
//
// Gmail is the default and needs nothing else. Anything else takes MAIL_HOST
// and MAIL_PORT as well.
//
// A missing mailbox is not an error to be discovered halfway through sending
// twenty payslips: `mailbox()` says so up front, and the screen shows it
// before there is a button to press.
import nodemailer from 'nodemailer';

const env = (name, fallback = '') => (process.env[name] || '').trim() || fallback;

export function mailbox() {
  const user = env('MAIL_USER');
  const pass = env('MAIL_PASS');
  return {
    ready: Boolean(user && pass),
    from: user || null,
    host: env('MAIL_HOST', 'smtp.gmail.com'),
    port: Number(env('MAIL_PORT', '465')),
    user,
    pass,
  };
}

let transport = null;

/**
 * Send one message. Throws with something a person can act on rather than an
 * SMTP code — the office reads these, not an engineer.
 */
export async function sendMail({ from, to, subject, text, html, attachments }) {
  const box = mailbox();
  if (!box.ready) {
    const e = new Error('No mailbox is connected yet. The owner adds MAIL_USER and '
      + 'MAIL_PASS in the hosting settings, then this button works.');
    e.status = 409;
    throw e;
  }
  transport ??= nodemailer.createTransport({
    host: box.host,
    port: box.port,
    secure: box.port === 465,
    auth: { user: box.user, pass: box.pass },
  });
  try {
    await transport.sendMail({
      from: from || box.user,
      sender: box.user,
      replyTo: box.user,
      to,
      subject,
      text,
      html,
      attachments,
    });
  } catch (err) {
    // Gmail refuses a plain account password with this, and the message it
    // gives back is a support article. Say the actual fix instead.
    if (/invalid login|authentication|535|534/i.test(err.message || '')) {
      const e = new Error('The mailbox would not accept that password. Gmail needs an '
        + 'app password, not the ordinary one.');
      e.status = 502;
      throw e;
    }
    const e = new Error(`The mail server would not take it: ${err.message}`);
    e.status = 502;
    throw e;
  }
}
