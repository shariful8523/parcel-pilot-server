import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { MongoClient, ServerApiVersion } from "mongodb";
import { ObjectId } from "mongodb"; // Import ObjectId
dotenv.config();
const app = express();
const port = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.wfpeu.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();

    const db = client.db("parcelDB"); // database name
    const parcelCollection = db.collection("parcels"); // collection

    // GET all parcels

    app.get("/parcels", async (req, res) => {
      const parcels = await parcelCollection.find().toArray();
      res.send(parcels);
    });

    // parcels api
    // GET: All parcels OR parcels by user (created_by), sorted by latest
    app.get("/parcels", async (req, res) => {
      try {
        const userEmail = req.query.email;

        const query = userEmail ? { created_by: userEmail } : {};
        const options = {
          sort: { createdAt: -1 }, // Newest first
        };

        const parcels = await parcelCollection.find(query, options).toArray();
        res.send(parcels);
      } catch (error) {
        console.error("Error fetching parcels:", error);
        res.status(500).send({ message: "Failed to get parcels" });
      }
    });

    // DELETE a parcel by ID
    app.delete("/parcels/:id", async (req, res) => {
      try {
        const parcelId = req.params.id;
        if (!ObjectId.isValid(parcelId)) {
          return res.status(400).send({ message: "Invalid parcel ID" });
        }

        const result = await parcelCollection.deleteOne({
          _id: new ObjectId(parcelId),
        });

        if (result.deletedCount > 0) {
          res.send({
            message: "Parcel deleted successfully",
            deletedCount: result.deletedCount,
          });
        } else {
          res
            .status(404)
            .send({ message: "Parcel not found", deletedCount: 0 });
        }
      } catch (error) {
        console.error("Error deleting parcel:", error);
        res.status(500).send({ message: "Failed to delete parcel" });
      }
    });

    //  POST a new parcel
    app.post("/parcels", async (req, res) => {
      const newParcel = req.body;
      const result = await parcelCollection.insertOne(newParcel);
      res.send({
        message: "Parcel added successfully!",
        insertedId: result.insertedId,
      });
    });




    

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

// Sample route
app.get("/", (req, res) => {
  res.send("Parcel Server is running");
});

// Start server
app.listen(port, () => {
  console.log(`🔥 Server running on port ${port}`);
});
