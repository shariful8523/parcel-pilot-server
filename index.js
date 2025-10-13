import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { MongoClient, ServerApiVersion, ObjectId } from "mongodb";
import Stripe from "stripe";

dotenv.config();
const app = express();
const port = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

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

    //  GET: All parcels or by user email
    app.get("/parcels", async (req, res) => {
      try {
        const userEmail = req.query.email;
        const query = userEmail ? { created_by: userEmail } : {};
        const options = { sort: { createdAt: -1 } };
        const parcels = await parcelCollection.find(query, options).toArray();
        res.send(parcels);
      } catch (error) {
        console.error("Error fetching parcels:", error);
        res.status(500).send({ message: "Failed to get parcels" });
      }
    });

    //  GET: Single parcel by ID
    app.get("/parcels/:id", async (req, res) => {
      try {
        const parcelId = req.params.id;
        if (!ObjectId.isValid(parcelId)) return res.status(400).send({ message: "Invalid parcel ID" });

        const parcel = await parcelCollection.findOne({ _id: new ObjectId(parcelId) });
        if (!parcel) return res.status(404).send({ message: "Parcel not found" });

        res.send(parcel);
      } catch (error) {
        console.error("Error fetching parcel by ID:", error);
        res.status(500).send({ message: "Failed to get parcel" });
      }
    });

    //  POST: Create new parcel
    app.post("/parcels", async (req, res) => {
      try {
        const newParcel = {
          ...req.body,
          createdAt: new Date(),
        };
        const result = await parcelCollection.insertOne(newParcel);
        res.send({ message: "Parcel added successfully!", insertedId: result.insertedId });
      } catch (error) {
        console.error("Error adding parcel:", error);
        res.status(500).send({ message: "Failed to add parcel" });
      }
    });

    //  DELETE: Remove a parcel
    app.delete("/parcels/:id", async (req, res) => {
      try {
        const parcelId = req.params.id;
        if (!ObjectId.isValid(parcelId)) return res.status(400).send({ message: "Invalid parcel ID" });

        const result = await parcelCollection.deleteOne({ _id: new ObjectId(parcelId) });
        if (result.deletedCount > 0) {
          res.send({ message: "Parcel deleted successfully" });
        } else {
          res.status(404).send({ message: "Parcel not found" });
        }
      } catch (error) {
        console.error("Error deleting parcel:", error);
        res.status(500).send({ message: "Failed to delete parcel" });
      }
    });

    //  Stripe Payment Intent
    app.post("/create-payment-intent", async (req, res) => {
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
        console.error("Error creating payment intent:", error);
        res.status(500).send({ message: "Failed to create payment intent" });
      }
    });

    //  GET: Payment history (user-specific or all for admin)
    app.get("/payments", async (req, res) => {
      try {
        const userEmail = req.query.email;
        const query = userEmail ? { email: userEmail } : {};
        const options = { sort: { paid_at: -1 } };
        const payments = await paymentCollection.find(query, options).toArray();
        res.send(payments);
      } catch (error) {
        console.error("Error fetching payments:", error);
        res.status(500).send({ message: "Failed to get payments" });
      }
    });

    //  POST: Record payment & mark parcel as paid
    app.post("/payments", async (req, res) => {
      try {
        const { parcelId, userEmail, userName, amount, transactionId, paymentMethod } = req.body;

        // Update parcel payment status
        const updateResult = await parcelCollection.updateOne(
          { _id: new ObjectId(parcelId) },
          { $set: { payment_status: "paid" } }
        );

        if (updateResult.modifiedCount === 0) {
          return res.status(404).send({ message: "Parcel not found or already paid" });
        }

        // Save payment record
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

        res.status(201).send({
          message: "Payment recorded and parcel marked as paid",
          insertedId: paymentResult.insertedId,
        });
      } catch (error) {
        console.error("Payment processing failed:", error);
        res.status(500).send({ message: "Failed to record payment" });
      }
    });

    // Ping MongoDB
    await client.db("admin").command({ ping: 1 });
    console.log(" Connected to MongoDB successfully!");
  } finally {
    // await client.close(); // Keep connection alive for API
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
