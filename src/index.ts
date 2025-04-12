import express, { Request, Response } from "express";
import Stripe from "stripe";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import dotenv from "dotenv";

dotenv.config();

const serviceAccount = {
  projectId: process.env.FIREBASE_PROJECT_ID,
  clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
  privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
};

initializeApp({
  credential: cert(serviceAccount),
});

const db = getFirestore();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET!;

const app = express();

// Stripe requires the raw body to validate webhook signatures
app.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  async (req: Request, res: Response): Promise<void> => {
    const sig = req.headers["stripe-signature"] as string | undefined;

    let event: Stripe.Event;

    try {
      event = stripe.webhooks.constructEvent(req.body, sig!, endpointSecret);
    } catch (err: any) {
      console.error("Webhook Error:", err.message);
      res.status(400).send(`Webhook Error: ${err.message}`);
      return;
    }

    // ✅ Handle completed checkout sessions
    // if (event.type === "checkout.session.completed") {
    //   const session = event.data.object as Stripe.Checkout.Session;
    //   const email = session.customer_details?.email;
    //   const expiresAt = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60; // 30 days

    //   if (!email) {
    //     console.error("No email found in session.");
    //     res.status(400).send("Email not found");
    //     return;
    //   }

    //   console.log("Creating Firestore document...");
    //   console.log("Email:", email);
    //   console.log("Expires At:", expiresAt);

    //   try {
    //     const docRef = await db.collection("tokens").add({
    //       email,
    //       deviceId: "",
    //       expiresAt,
    //       isRadioOff: false,
    //       isTrial: true,
    //     });

    //     console.log("Firestore doc created with ID:", docRef.id);
    //   } catch (error) {
    //     console.error("Error creating Firestore document:", error);
    //     res.status(500).send("Error creating Firestore document");
    //     return;
    //   }
    // }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;
      const email = session.customer_details?.email;

      if (!email) {
        console.error("No email found in session.");
        res.status(400).send("Email not found");
        return;
      }

      try {
        const lineItems = await stripe.checkout.sessions.listLineItems(
          session.id
        );
        const itemName =
          lineItems.data[0]?.description?.toLowerCase() ?? "30days";

        let durationDays = 30; // default
        if (itemName.includes("7")) durationDays = 7;
        else if (itemName.includes("30")) durationDays = 30;
        else if (itemName.includes("year")) durationDays = 365;

        const expiresAt = Math.floor(Date.now() / 1000) + durationDays * 86400;

        console.log("Email:", email);
        console.log("Duration (days):", durationDays);
        console.log("Expires At:", expiresAt);

        const docRef = await db.collection("tokens").add({
          email,
          deviceId: "",
          expiresAt,
          isRadioOff: false,
          isTrial: false,
        });

        console.log("Firestore doc created with ID:", docRef.id);
      } catch (error) {
        console.error("Error processing session:", error);
        res.status(500).send("Internal error");
        return;
      }
    }

    // ✅ Always send a response to Stripe
    res.status(200).send("Webhook received");
  }
);

app.listen(3000, () => console.log("Running on http://localhost:3000"));
