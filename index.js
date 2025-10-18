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

// ------------------------ Middleware ------------------------
app.use(cors());
app.use(express.json());

// ------------------------ Firebase Admin ------------------------
const serviceAccount = JSON.parse(
  fs.readFileSync(
    new URL("./firebase-admin-key.json", import.meta.url),
    "utf-8"
  )
);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// ------------------------ Stripe ------------------------
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ------------------------ MongoDB ------------------------
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.wfpeu.mongodb.net/?retryWrites=true&w=majority`;
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

// ------------------------ Run Server ------------------------
async function run() {
  try {
    await client.connect();
    const db = client.db("parcelDB");
    const parcelCollection = db.collection("parcels");
    const paymentCollection = db.collection("payments");
    const usersCollection = db.collection("users");
    const trackingsCollection = db.collection("trackings");
    const ridersCollection = db.collection("riders");

    // ------------------------ Firebase Token ------------------------
    const verifyFBToken = async (req, res, next) => {
      const authHeader = req.headers.authorization;
      if (!authHeader)
        return res.status(401).send({ message: "Unauthorized access" });

      const token = authHeader.split(" ")[1];
      if (!token)
        return res.status(401).send({ message: "Unauthorized access" });

      try {
        req.decoded = await admin.auth().verifyIdToken(token);
        next();
      } catch {
        return res.status(403).send({ message: "Forbidden access" });
      }
    };

    // ------------------------ Admin Verification ------------------------
    const verifyAdmin = async (req, res, next) => {
      const email = req.decoded.email;
      const user = await usersCollection.findOne({ email });
      if (!user || user.role !== "admin")
        return res.status(403).send({ message: "Forbidden access" });
      next();
    };

    // ------------------------ Root Route ------------------------
    app.get("/", (req, res) => res.send("🚀 Parcel Server is running"));

    // ------------------------ Users Routes ------------------------

    // Search users by email
    app.get("/users/search", verifyFBToken, verifyAdmin, async (req, res) => {
      const emailQuery = req.query.email;
      if (!emailQuery)
        return res.status(400).send({ message: "Missing email query" });

      try {
        const users = await usersCollection
          .find({ email: { $regex: `^${emailQuery}`, $options: "i" } }) // case-insensitive
          .limit(10)
          .toArray();
        res.send(users);
      } catch (err) {
        res.status(500).send({ message: "Error searching users" });
      }
    });

    // Get user role by email
    app.get("/users/:email/role", verifyFBToken, async (req, res) => {
      const email = req.params.email;
      if (!email) return res.status(400).send({ message: "Email required" });

      try {
        const user = await usersCollection.findOne({
          email: { $regex: `^${email}$`, $options: "i" },
        });
        if (!user) return res.status(404).send({ message: "User not found" });

        res.send({ role: user.role || "user" });
      } catch (err) {
        res.status(500).send({ message: "Error fetching user role" });
      }
    });

    // Update user role
    app.patch(
      "/users/:id/role",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        const { id } = req.params;
        const { role } = req.body;
        if (!["admin", "user"].includes(role))
          return res.status(400).send({ message: "Invalid role" });

        try {
          const result = await usersCollection.updateOne(
            { _id: new ObjectId(id) },
            { $set: { role } }
          );
          res.send({ message: `User role updated to ${role}`, result });
        } catch (err) {
          res.status(500).send({ message: "Error updating user role" });
        }
      }
    );

    // Add new user or update last login if exists
    app.post("/users", async (req, res) => {
      const email = req.body.email;
      try {
        const userExists = await usersCollection.findOne({
          email: { $regex: `^${email}$`, $options: "i" },
        });
        if (userExists) {
          await usersCollection.updateOne(
            { _id: userExists._id },
            { $set: { last_log_in: new Date().toISOString() } }
          );
          return res
            .status(200)
            .send({ message: "User already exists", inserted: false });
        }
        const result = await usersCollection.insertOne({
          ...req.body,
          created_at: new Date().toISOString(),
        });
        res.send(result);
      } catch (err) {
        res.status(500).send({ message: "Error adding user" });
      }
    });

    // Get latest users
    app.get("/users", verifyFBToken, verifyAdmin, async (req, res) => {
      try {
        const users = await usersCollection
          .find()
          .sort({ created_at: -1 })
          .limit(50)
          .toArray();
        res.send(users);
      } catch (err) {
        res.status(500).send({ message: "Error fetching users" });
      }
    });

    // ------------------------ Parcel Routes ------------------------
    app.get("/parcels", verifyFBToken, async (req, res) => {
      const { email, payment_status, delivery_status } = req.query;
      let query = {};
      if (email) query.created_by = email;
      if (payment_status) query.payment_status = payment_status;
      if (delivery_status) query.delivery_status = delivery_status;

      const parcels = await parcelCollection
        .find(query, { sort: { createdAt: -1 } })
        .toArray();
      res.send(parcels);
    });

    app.get("/parcels/:id", verifyFBToken, async (req, res) => {
      const parcelId = req.params.id;
      if (!ObjectId.isValid(parcelId))
        return res.status(400).send({ message: "Invalid parcel ID" });
      const parcel = await parcelCollection.findOne({
        _id: new ObjectId(parcelId),
      });
      if (!parcel) return res.status(404).send({ message: "Parcel not found" });
      res.send(parcel);
    });

    // GET: Get pending delivery tasks for a rider
    app.get("/rider/parcels", verifyFBToken, async (req, res) => {
      try {
        const email = req.query.email;

        if (!email) {
          return res.status(400).send({ message: "Rider email is required" });
        }

        const query = {
          assigned_rider_email: email,
          delivery_status: { $in: ["rider_assigned", "in_transit"] },
        };

        const options = {
          sort: { creation_date: -1 }, // Newest first
        };

        const parcels = await parcelCollection.find(query, options).toArray();
        res.send(parcels);
      } catch (error) {
        console.error("Error fetching rider tasks:", error);
        res.status(500).send({ message: "Failed to get rider tasks" });
      }
    });

    // GET: Load completed parcel deliveries for a rider
    app.get("/rider/completed-parcels", verifyFBToken, async (req, res) => {
      try {
        const email = req.query.email;

        if (!email) {
          return res.status(400).send({ message: "Rider email is required" });
        }

        const query = {
          assigned_rider_email: email,
          delivery_status: {
            $in: ["delivered", "service_center_delivered"],
          },
        };

        const options = {
          sort: { creation_date: -1 }, // Latest first
        };

        const completedParcels = await parcelCollection
          .find(query, options)
          .toArray();

        res.send(completedParcels);
      } catch (error) {
        console.error("Error loading completed parcels:", error);
        res
          .status(500)
          .send({ message: "Failed to load completed deliveries" });
      }
    });

    app.post("/parcels", verifyFBToken, async (req, res) => {
      const result = await parcelCollection.insertOne({
        ...req.body,
        createdAt: new Date(),
      });
      res.send({
        message: "Parcel added successfully!",
        insertedId: result.insertedId,
      });
    });

    app.patch("/parcels/:id/assign", verifyFBToken, async (req, res) => {
      const parcelId = req.params.id;
      const { riderId, riderName, riderEmail } = req.body;

      try {
        // Update parcel
        await parcelCollection.updateOne(
          { _id: new ObjectId(parcelId) },
          {
            $set: {
              delivery_status: "rider_assigned",
              assigned_rider_id: riderId,
              assigned_rider_email: riderEmail,
              assigned_rider_name: riderName,
            },
          }
        );

        // Update rider
        await ridersCollection.updateOne(
          { _id: new ObjectId(riderId) },
          {
            $set: {
              work_status: "in_delivery",
            },
          }
        );

        res.send({ message: "Rider assigned" });
      } catch (err) {
        console.error(err);
        res.status(500).send({ message: "Failed to assign rider" });
      }
    });

    app.patch("/parcels/:id/status", async (req, res) => {
      const parcelId = req.params.id;
      const { status } = req.body;
      const updatedDoc = {
        delivery_status: status,
      };

      if (status === "in_transit") {
        updatedDoc.picked_at = new Date().toISOString();
      } else if (status === "delivered") {
        updatedDoc.delivered_at = new Date().toISOString();
      }

      try {
        const result = await parcelCollection.updateOne(
          { _id: new ObjectId(parcelId) },
          {
            $set: updatedDoc,
          }
        );
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Failed to update status" });
      }
    });

    app.patch("/parcels/:id/cashout", async (req, res) => {
      const id = req.params.id;
      const result = await parcelCollection.updateOne(
        { _id: new ObjectId(id) },
        {
          $set: {
            cashout_status: "cashed_out",
            cashed_out_at: new Date(),
          },
        }
      );
      res.send(result);
    });

    app.delete("/parcels/:id", verifyFBToken, async (req, res) => {
      const parcelId = req.params.id;
      if (!ObjectId.isValid(parcelId))
        return res.status(400).send({ message: "Invalid parcel ID" });
      const result = await parcelCollection.deleteOne({
        _id: new ObjectId(parcelId),
      });
      res.send(
        result.deletedCount > 0
          ? { message: "Parcel deleted successfully" }
          : { message: "Parcel not found" }
      );
    });

    // ------------------------ Stripe Payment Intent ------------------------
    app.post("/create-payment-intent", verifyFBToken, async (req, res) => {
      const { amountInCent } = req.body;
      if (!amountInCent || amountInCent <= 0)
        return res.status(400).send({ message: "Invalid payment amount" });

      const paymentIntent = await stripe.paymentIntents.create({
        amount: amountInCent,
        currency: "bdt",
        payment_method_types: ["card"],
      });
      res.send({ clientSecret: paymentIntent.client_secret });
    });

    // ------------------------ Tracking ------------------------
    app.get("/trackings/:trackingId", async (req, res) => {
            const trackingId = req.params.trackingId;

            const updates = await trackingsCollection
                .find({ tracking_id: trackingId })
                .sort({ timestamp: 1 }) 
                .toArray();

            res.json(updates);
        });

        app.post("/trackings", async (req, res) => {
            const update = req.body;

            update.timestamp = new Date(); 
            if (!update.tracking_id || !update.status) {
                return res.status(400).json({ message: "tracking_id and status are required." });
            }

            const result = await trackingsCollection.insertOne(update);
            res.status(201).json(result);
        });


    // ------------------------ Payments ------------------------
    app.get("/payments", verifyFBToken, async (req, res) => {
      const userEmail = req.query.email;
      const payments = await paymentCollection
        .find(userEmail ? { email: userEmail } : {}, { sort: { paid_at: -1 } })
        .toArray();
      res.send(payments);
    });

    app.post("/payments", verifyFBToken, async (req, res) => {
      const {
        parcelId,
        userEmail,
        userName,
        amount,
        transactionId,
        paymentMethod,
      } = req.body;
      await parcelCollection.updateOne(
        { _id: new ObjectId(parcelId) },
        { $set: { payment_status: "paid" } }
      );
      const paymentResult = await paymentCollection.insertOne({
        parcelId,
        email: userEmail,
        userName,
        amount,
        paymentMethod,
        transactionId,
        paid_at: new Date(),
        paid_at_string: new Date().toLocaleString("en-BD", {
          timeZone: "Asia/Dhaka",
        }),
      });
      res.status(201).send({
        message: "Payment recorded and parcel marked as paid",
        insertedId: paymentResult.insertedId,
      });
    });

    // ------------------------ Riders ------------------------
    app.post("/riders", async (req, res) => {
      const result = await ridersCollection.insertOne(req.body);
      res.send(result);
    });

    app.get("/riders/pending", async (req, res) => {
      const result = await ridersCollection
        .find({ status: "pending" })
        .toArray();
      res.send(result);
    });

    app.get("/riders/active", async (req, res) => {
      const result = await ridersCollection
        .find({ status: "active" })
        .toArray();
      res.send(result);
    });

    app.get("/riders/available", async (req, res) => {
      const { district } = req.query;
      const result = await ridersCollection.find({ district }).toArray();
      res.send(result);
    });

    app.patch("/riders/:id/status", async (req, res) => {
      const { id } = req.params;
      const { status, email } = req.body;
      const result = await ridersCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { status } }
      );

      if (status === "active") {
        await usersCollection.updateOne({ email }, { $set: { role: "rider" } });
      }

      res.send(result);
    });

    // ------------------------ Ping MongoDB ------------------------
    await client.db("admin").command({ ping: 1 });
    console.log("✅ Connected to MongoDB successfully!");
  } finally {
    // Keep connection alive
  }
}

run().catch(console.dir);

// ------------------------ Start Server ------------------------
app.listen(port, () => console.log(`🔥 Server running on port ${port}`));
