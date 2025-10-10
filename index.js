import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { MongoClient, ServerApiVersion } from "mongodb";

dotenv.config();
const app = express();
const port = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// Sample route
app.get('/', (req, res) => {
    res.send('Parcel Server is running')
})


// Start server
app.listen(port, () => {
  console.log(`🔥 Server running on port ${port}`);
});