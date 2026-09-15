/**
 * Getting a login code to a person.
 *
 * Two channels, both optional. Whichever one a contact implies is used if it's
 * configured; if it isn't, the code goes to the worker log instead and the
 * caller is told delivery didn't really happen. That last part matters — a
 * silent no-op would look exactly like a code lost in a spam folder, and
 * you'd go looking in the wrong place.
 */

import type { Contact } from "./identity";

export interface NotifyEnv {
  /** Email, via Resend. */
  RESEND_API_KEY?: string;
  /** Verified sender, e.g. `Meet Runner <meets@example.com>`. */
  AUTH_FROM_EMAIL?: string;
  /** Text messages, via Twilio. */
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_AUTH_TOKEN?: string;
  /** The Twilio number codes are sent from, in E.164. */
  TWILIO_FROM?: string;
  /**
   * Put the code in the API response so a local build can sign in without any
   * provider set up. Never set this on a deployed worker: it hands a login to
   * anyone who can name an address.
   */
  AUTH_DEV_CODES?: string;
}

export interface Delivery {
  /** False when nothing was actually sent and the code only reached the log. */
  sent: boolean;
  /** How it went, for the log and — when it failed — for the person. */
  detail: string;
}

/**
 * Send the code, and say honestly whether it went anywhere.
 *
 * A provider failure is reported rather than thrown: the challenge is already
 * stored by this point, and a code that can still be delivered another way
 * (or read from the log) is better than a 500 that loses it.
 */
export async function sendLoginCode(
  env: NotifyEnv,
  contact: Contact,
  code: string,
  link: string,
): Promise<Delivery> {
  try {
    if (contact.kind === "email") return await sendEmail(env, contact.value, code, link);
    return await sendSms(env, contact.value, code);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Delivery failed";
    console.error(`Could not send a login code to ${contact.value}:`, detail);
    return { sent: false, detail };
  }
}

/**
 * The email carries both a link and the code.
 *
 * The link is the quick path when mail is read on the same device in the same
 * browser; the code is the one that always works, including when the link
 * opens in a webview that isn't where the app is. Neither is enough alone.
 */
async function sendEmail(
  env: NotifyEnv,
  address: string,
  code: string,
  link: string,
): Promise<Delivery> {
  if (!env.RESEND_API_KEY || !env.AUTH_FROM_EMAIL) {
    return logOnly("email", address, code, "RESEND_API_KEY / AUTH_FROM_EMAIL");
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: env.AUTH_FROM_EMAIL,
      to: address,
      subject: `${code} is your Meet Runner code`,
      text: [
        `Your Meet Runner sign-in code is ${code}.`,
        "",
        `Or open this link on the device you're signing in on:`,
        link,
        "",
        "The code is good for ten minutes. If you didn't ask for it, ignore this.",
      ].join("\n"),
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Resend refused the message (${response.status}) ${body}`.trim());
  }
  return { sent: true, detail: "Emailed" };
}

async function sendSms(env: NotifyEnv, number: string, code: string): Promise<Delivery> {
  const { TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: token, TWILIO_FROM: from } = env;
  if (!sid || !token || !from) {
    return logOnly("phone", number, code, "TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM");
  }

  // No link here on purpose: a URL in a text is what makes it look like the
  // scam it would otherwise resemble, and carriers filter accordingly.
  const response = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
    {
      method: "POST",
      headers: {
        authorization: `Basic ${btoa(`${sid}:${token}`)}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        To: number,
        From: from,
        Body: `${code} is your Meet Runner code. It expires in ten minutes.`,
      }),
    },
  );

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Twilio refused the message (${response.status}) ${body}`.trim());
  }
  return { sent: true, detail: "Texted" };
}

/**
 * Tell somebody they're running a meet, and hand them the link.
 *
 * The link is the whole message. Unlike a login code there's no fallback to
 * read out — the token is what proves the contact and drops them on the meet
 * — so a text carries it too, despite the note on `sendSms` about URLs. A
 * meet invitation without its link is just a rumour.
 */
export async function sendMeetInvite(
  env: NotifyEnv,
  contact: Contact,
  link: string,
): Promise<Delivery> {
  const subject = "You've been asked to run a meet";
  const lines = [
    "You've been asked to help run a meet on Meet Runner.",
    "",
    "Open this link to sign in and go straight to it:",
    link,
    "",
    "The link is good for two weeks. If you weren't expecting it, ignore this.",
  ];

  try {
    if (contact.kind === "email") {
      if (!env.RESEND_API_KEY || !env.AUTH_FROM_EMAIL) {
        return logOnlyLink("email", contact.value, link, "RESEND_API_KEY / AUTH_FROM_EMAIL");
      }
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.RESEND_API_KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          from: env.AUTH_FROM_EMAIL,
          to: contact.value,
          subject,
          text: lines.join("\n"),
        }),
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`Resend refused the message (${response.status}) ${body}`.trim());
      }
      return { sent: true, detail: "Emailed" };
    }

    const { TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: token, TWILIO_FROM: from } = env;
    if (!sid || !token || !from) {
      return logOnlyLink(
        "phone",
        contact.value,
        link,
        "TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM",
      );
    }
    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
      {
        method: "POST",
        headers: {
          authorization: `Basic ${btoa(`${sid}:${token}`)}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          To: contact.value,
          From: from,
          Body: `You've been asked to help run a meet on Meet Runner: ${link}`,
        }),
      },
    );
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Twilio refused the message (${response.status}) ${body}`.trim());
    }
    return { sent: true, detail: "Texted" };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Delivery failed";
    console.error(`Could not send a meet invitation to ${contact.value}:`, detail);
    return { sent: false, detail };
  }
}

function logOnlyLink(
  kind: string,
  to: string,
  link: string,
  missing: string,
): Delivery {
  console.warn(
    `No ${kind} provider configured (${missing}). Meet invitation for ${to} is ${link}`,
  );
  return {
    sent: false,
    detail: `No ${kind} provider is configured on this server.`,
  };
}

function logOnly(
  kind: string,
  to: string,
  code: string,
  missing: string,
): Delivery {
  console.warn(
    `No ${kind} provider configured (${missing}). Login code for ${to} is ${code}.`,
  );
  return {
    sent: false,
    detail: `No ${kind} provider is configured on this server.`,
  };
}

/** Whether the code may be handed straight back to the caller. Local only. */
export function revealsCodes(env: NotifyEnv): boolean {
  return env.AUTH_DEV_CODES === "1" || env.AUTH_DEV_CODES === "true";
}
