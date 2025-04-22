import express, { Request, Response } from "express";
import Stripe from "stripe";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import dotenv from "dotenv";
import axios from "axios";
import cors from "cors";

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

///////////////////////////////////////
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

    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;
      const email = session.customer_details?.email;

      if (!email) {
        res.status(400).send("Email not found");
        return;
      }

      try {
        const lineItems = await stripe.checkout.sessions.listLineItems(
          session.id
        );

        const description = lineItems.data[0]?.description?.toLowerCase() ?? "";
        console.log("Line item description:", description);

        let durationDays = 30;
        if (description.includes("7")) durationDays = 7;
        else if (description.includes("30")) durationDays = 30;
        else if (description.includes("year")) durationDays = 365;

        const expiresAt = Math.floor(Date.now() / 1000) + durationDays * 86400;

        await db.collection("tokens").add({
          email,
          deviceId: "",
          expiresAt,
          isRadioOff: false,
          isTrial: false,
        });

        res.status(200).send("Success");
      } catch (err) {
        console.error("Webhook error:", err);
        res.status(500).send("Error processing webhook");
      }
    }

    // ✅ Always send a response to Stripe
    res.status(200).send("Webhook received");
  }
);

app.use(express.json());

// Allow requests from your frontend domain
// app.use(
//   cors({
//     origin: "*",
//     methods: ["GET", "POST"],
//   })
// );

///////////////////////////////////////

// Endpoint to handle fetching session data
app.get("/api/thank-you", async (req: Request, res: Response): Promise<any> => {
  const { session_id } = req.query;

  if (!session_id || typeof session_id !== "string") {
    return res
      .status(400)
      .json({ success: false, message: "Session ID is required" });
  }

  try {
    // Retrieve the session details from Stripe
    const session = await stripe.checkout.sessions.retrieve(session_id);

    // Extract customer information
    const customerDetails = {
      name: session.customer_details?.name ?? "Anonymous",
      email: session.customer_details?.email ?? "No email found",
    };

    // Query Firestore using the email to get the document ID
    const userQuerySnapshot = await db
      .collection("tokens")
      .where("email", "==", customerDetails.email)
      .get();

    if (userQuerySnapshot.empty) {
      return res
        .status(404)
        .json({ success: false, message: "No user found with this email" });
    }

    // Assuming there's only one document per email
    const userDoc = userQuerySnapshot.docs[0]; // Get the first matching document
    const documentId = userDoc.id; // Get the document ID

    // Combine Firestore document ID with the customer details
    const result = {
      ...customerDetails,
      documentId: documentId, // Add document ID to the response
    };

    // Send the customer details along with the Firestore document ID to the frontend
    res.json({ success: true, customerDetails: result });
  } catch (error) {
    console.error("Error fetching session or Firestore document:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching session or Firestore document",
    });
  }
});

app.get(
  "/api/paystack-confirmation",
  async (req: Request, res: Response): Promise<any> => {
    const { reference } = req.query;

    if (!reference || typeof reference !== "string") {
      return res
        .status(400)
        .json({ success: false, message: "Reference is required" });
    }

    try {
      // Verify the Paystack transaction using the reference
      const paystackRes = await axios.get(
        `https://api.paystack.co/transaction/verify/${reference}`,
        {
          headers: {
            Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
          },
        }
      );

      const email = (paystackRes.data as any)?.data?.customer?.email;
      const first_name = (paystackRes.data as any)?.data?.customer?.first_name;
      const last_name = (paystackRes.data as any)?.data?.customer?.last_name;

      // const email = (paystackRes.data as { customer: { email: string } })
      //   .customer.email;
      // const name = (paystackRes.data as { name: string }).name;
      // console.log(email);
      // console.log(name);

      // Extract customer information
      const paystackApiDetails = {
        name: first_name + last_name,
        email: email,
      };

      // const email = paystackRes.data.customer.email;
      // const name = paystackRes.data.reference;

      if (!email) {
        return res.status(404).json({
          success: false,
          message: "Customer email not found in Paystack data",
        });
      }

      // Lookup Firestore for the token using the email
      const userQuerySnapshot = await db
        .collection("tokens")
        .where("email", "==", email)
        .get();

      if (userQuerySnapshot.empty) {
        return res.status(404).json({
          success: false,
          message: "No user found with this email in Firestore",
        });
      }

      const userDoc = userQuerySnapshot.docs[0];
      const documentId = userDoc.id;

      const result = {
        ...paystackApiDetails,
        documentId: documentId, // Add document ID to the response
      };

      res.json({ success: true, paystackApiDetails: result });
    } catch (error) {
      console.error("❌ Paystack verification error:", error);
      res.status(500).json({
        success: false,
        message: "Error verifying Paystack reference or querying Firestore",
      });
    }
  }
);

app.get("/ping", (req: Request, res: Response): void => {
  res.status(200).send("ok");
});

app.post("/create-trial-subscription", async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [
        {
          price: "price_1REdBNAYZ3Va2rSeqnjqgMP7", // replace with your actual Stripe price ID
          quantity: 1,
        },
      ],
      subscription_data: {
        trial_period_days: 7,
      },
      metadata: {
        duration: "7", // optional if used in webhook
      },
      success_url: `https://subscribe.lamboliveagency.com/thank-you/?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `https://subscribe.lamboliveagency.com/thank-you/`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("Stripe session creation error:", err);
    res.status(500).json({ error: "Failed to create checkout session" });
  }
});

// 🔐 To verify Paystack signature
import crypto from "crypto";

app.post(
  "/paystack/webhook",
  express.json(),
  async (req, res): Promise<void> => {
    const secret = process.env.PAYSTACK_SECRET_KEY!;
    const hash = crypto
      .createHmac("sha512", secret)
      .update(JSON.stringify(req.body))
      .digest("hex");

    if (hash !== req.headers["x-paystack-signature"]) {
      res.status(401).send("Invalid signature");
      return;
    }

    // 👇 Log the full webhook payload
    console.log("🔔 Webhook received:");
    console.dir(req.body, { depth: null });

    const event = req.body;
    console.log("📦 Paystack Event:", event.event);

    if (
      event.event === "subscription.create" ||
      event.event === "charge.success"
    ) {
      const customerEmail = event.data.customer.email;
      const planName = event.data.plan?.name?.toLowerCase() || "";

      // Detect duration from plan name (e.g., "7days trial")
      let durationDays = 30;
      if (planName.includes("7")) durationDays = 7;
      else if (planName.includes("30")) durationDays = 30;
      else if (planName.includes("year")) durationDays = 365;

      const expiresAt = Math.floor(Date.now() / 1000) + durationDays * 86400;

      try {
        const docRef = await db.collection("tokens").add({
          email: customerEmail,
          deviceId: "",
          expiresAt,
          isRadioOff: false,
          isTrial: planName.includes("7"),
        });

        console.log("✅ Firestore saved for:", customerEmail);
      } catch (err) {
        console.error("❌ Firestore error:", err);
      }
    }

    res.sendStatus(200);
  }
);

app.post("/api/create-dummy-user", async (req, res): Promise<void> => {
  const { email, token, customId } = req.body;

  if (!email || !token || !customId) {
    res.status(400).json({ error: "Missing required fields" });
    return;
  }

  try {
    const docRefid = db.collection("tokens").doc(customId); // custom ID here
    await docRefid.set({
      email,
      deviceId: "",
      expiresAt: 12344343434,
      isRadioOff: false,
      isTrial: false,
    });

    res
      .status(200)
      .json({ success: true, message: "User created with custom ID" });
  } catch (error) {
    console.error("Error creating document:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

app.listen(3000, () => console.log("Running on http://localhost:3000"));
