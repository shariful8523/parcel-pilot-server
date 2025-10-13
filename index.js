import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { MongoClient, ServerApiVersion, ObjectId } from "mongodb";
import Stripe from "stripe";
import admin from "firebase-admin";
import fs from "fs";

dotenv.config();

const app = express();
const port = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// Firebase Admin initialization (ESM safe)
const serviceAccount = JSON.parse(fs.readFileSync(new URL("./firebase-admin-key.json", import.meta.url), "utf-8"));

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// Stripe setup
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// MongoDB setup
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.wfpeu.mongodb.net/?retryWrites=true&w=majority`;
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    await client.connect();
    const db = client.db("parcelDB");
    const parcelCollection = db.collection("parcels");
    const paymentCollection = db.collection("payments");
    const usersCollection = db.collection("users");
    const trackingCollection = db.collection("tracking");

    // Middleware: Firebase token verification
    const verifyFBToken = async (req, res, next) => {
      const authHeader = req.headers.authorization;
      if (!authHeader) return res.status(401).send({ message: "Unauthorized access" });

      const token = authHeader.split(" ")[1];
      if (!token) return res.status(401).send({ message: "Unauthorized access" });

      try {
        const decoded = await admin.auth().verifyIdToken(token);
        req.decoded = decoded;
        next();
      } catch (error) {
        return res.status(403).send({ message: "Forbidden access" });
      }
    };

    // Users API
    app.post("/users", verifyFBToken,  async (req, res) => {
      const email = req.body.email;
      const userExists = await usersCollection.findOne({ email });

      if (userExists) {
        // update last log in
        await usersCollection.updateOne(
          { email },
          { $set: { last_log_in: new Date().toISOString() } }
        );
        return res.status(200).send({ message: "User already exists", inserted: false });
      }

      const user = req.body;
      const result = await usersCollection.insertOne(user);
      res.send(result);
    });

    // Parcels API
    app.get("/parcels", verifyFBToken, async (req, res) => {
      try {
        const userEmail = req.query.email;
        const query = userEmail ? { created_by: userEmail } : {};
        const options = { sort: { createdAt: -1 } };
        const parcels = await parcelCollection.find(query, options).toArray();
        res.send(parcels);
      } catch (error) {
        res.status(500).send({ message: "Failed to get parcels" });
      }
    });

    app.get("/parcels/:id", verifyFBToken,  async (req, res) => {
      try {
        const parcelId = req.params.id;
        if (!ObjectId.isValid(parcelId)) return res.status(400).send({ message: "Invalid parcel ID" });

        const parcel = await parcelCollection.findOne({ _id: new ObjectId(parcelId) });
        if (!parcel) return res.status(404).send({ message: "Parcel not found" });

        res.send(parcel);
      } catch (error) {
        res.status(500).send({ message: "Failed to get parcel" });
      }
    });

    app.post("/parcels", verifyFBToken,  async (req, res) => {
      try {
        const newParcel = { ...req.body, createdAt: new Date() };
        const result = await parcelCollection.insertOne(newParcel);
        res.send({ message: "Parcel added successfully!", insertedId: result.insertedId });
      } catch (error) {
        res.status(500).send({ message: "Failed to add parcel" });
      }
    });

    app.delete("/parcels/:id", verifyFBToken,  async (req, res) => {
      try {
        const parcelId = req.params.id;
        if (!ObjectId.isValid(parcelId)) return res.status(400).send({ message: "Invalid parcel ID" });

        const result = await parcelCollection.deleteOne({ _id: new ObjectId(parcelId) });
        if (result.deletedCount > 0) res.send({ message: "Parcel deleted successfully" });
        else res.status(404).send({ message: "Parcel not found" });
      } catch (error) {
        res.status(500).send({ message: "Failed to delete parcel" });
      }
    });

    // Stripe Payment Intent
    app.post("/create-payment-intent", verifyFBToken,  async (req, res) => {
      try {
        const { amountInCent } = req.body;
        if (!amountInCent || amountInCent <= 0) return res.status(400).send({ message: "Invalid payment amount" });

        const paymentIntent = await stripe.paymentIntents.create({
          amount: amountInCent,
          currency: "bdt",
          payment_method_types: ["card"],
        });

        res.send({ clientSecret: paymentIntent.client_secret });
      } catch (error) {
        res.status(500).send({ message: "Failed to create payment intent" });
      }
    });

    // Tracking API
    app.post("/tracking", verifyFBToken,  async (req, res) => {
      const { tracking_id, parcel_id, status, message, updated_by = "" } = req.body;

      const log = {
        tracking_id,
        parcel_id: parcel_id ? new ObjectId(parcel_id) : undefined,
        status,
        message,
        time: new Date(),
        updated_by,
      };

      const result = await trackingCollection.insertOne(log);
      res.send({ success: true, insertedId: result.insertedId });
    });

    // Payments API
    app.get("/payments", verifyFBToken,  async (req, res) => {
      try {
        const userEmail = req.query.email;
        const query = userEmail ? { email: userEmail } : {};
        const options = { sort: { paid_at: -1 } };
        const payments = await paymentCollection.find(query, options).toArray();
        res.send(payments);
      } catch (error) {
        res.status(500).send({ message: "Failed to get payments" });
      }
    });

    app.post("/payments", verifyFBToken,  async (req, res) => {
      try {
        const { parcelId, userEmail, userName, amount, transactionId, paymentMethod } = req.body;

        await parcelCollection.updateOne({ _id: new ObjectId(parcelId) }, { $set: { payment_status: "paid" } });

        const paymentDoc = {
          parcelId,
          email: userEmail,
          userName,
          amount,
          paymentMethod,
          transactionId,
          paid_at: new Date(),
          paid_at_string: new Date().toLocaleString("en-BD", { timeZone: "Asia/Dhaka" }),
        };

        const paymentResult = await paymentCollection.insertOne(paymentDoc);
        res.status(201).send({ message: "Payment recorded and parcel marked as paid", insertedId: paymentResult.insertedId });
      } catch (error) {
        res.status(500).send({ message: "Failed to record payment" });
      }
    });

    await client.db("admin").command({ ping: 1 });
    console.log("✅ Connected to MongoDB successfully!");
  } finally {
    // Keep connection alive
  }
}

run().catch(console.dir);

// Root route
app.get("/", (req, res) => {
  res.send("🚀 Parcel Server is running");
});

// Start server
app.listen(port, () => {
  console.log(`🔥 Server running on port ${port}`);
});
