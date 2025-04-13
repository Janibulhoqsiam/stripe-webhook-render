import express, { Request, Response } from "express";
import Stripe from "stripe";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import dotenv from "dotenv";
import cors from 'cors';


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
app.post("/webhook",express.raw({ type: "application/json" }),
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
app.use(cors({
  origin: 'https://subscribe.lamboliveagency.com',
  methods: ['GET', 'POST'],
}))

///////////////////////////////////////

// Endpoint to handle fetching session data
app.get("/api/thank-you", async (req: Request, res: Response): Promise<any> => {
  const { session_id } = req.query;

  if (!session_id || typeof session_id !== "string") {
    return res.status(400).json({ success: false, message: "Session ID is required" });
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
    const userQuerySnapshot = await db.collection("tokens").where("email", "==", customerDetails.email).get();

    if (userQuerySnapshot.empty) {
      return res.status(404).json({ success: false, message: "No user found with this email" });
    }

    // Assuming there's only one document per email
    const userDoc = userQuerySnapshot.docs[0]; // Get the first matching document
    const documentId = userDoc.id;  // Get the document ID

    // Combine Firestore document ID with the customer details
    const result = {
      ...customerDetails,
      documentId: documentId, // Add document ID to the response
    };

    // Send the customer details along with the Firestore document ID to the frontend
    res.json({ success: true, customerDetails: result });
  } catch (error) {
    console.error("Error fetching session or Firestore document:", error);
    res.status(500).json({ success: false, message: "Error fetching session or Firestore document" });
  }

}

);




app.listen(3000, () => console.log("Running on http://localhost:3000"));
