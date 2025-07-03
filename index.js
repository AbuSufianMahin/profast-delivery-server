const express = require('express');
const app = express();
const port = process.env.PORT || 3000;

const cors = require('cors');
require('dotenv').config();
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');

// middlewire
app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
    res.send('Profast Delivery service is running')
})



const uri = `mongodb+srv://${process.env.PROFASTDB_ADMIN_USERNAME}:${process.env.PROFASTDB_ADMIN_PASS}@cluster0.udgfocl.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;
// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});

async function run() {
    try {
        await client.connect();
        await client.db("admin").command({ ping: 1 });
        console.log("Pinged your deployment. You successfully connected to MongoDB!");

        const parcelCollection = client.db("profast_delivery_db").collection("parcelCollection");


        app.get('/parcels', async (req, res) => {
            try {
                const userEmail = req.query.email;
                const query = userEmail ? { 'senderDetails.email': userEmail } : {};
                const options = {
                    sort: { 'parcelDetails.createdAt': -1 }
                }

                const result = await parcelCollection.find(query, options).toArray();
                res.send(result);
            }
            catch (error) {
                res.status(500).send({ message: 'Error Fetching parcels', error });
            }
        })

        app.post('/add-parcel', async (req, res) => {
            try {
                const parcelData = req.body;
                const result = await parcelCollection.insertOne(parcelData);
                res.status(200).send(result);
            } catch (error) {
                res.status(500).json({ error: "Failed to add parcel" });
            }
        })


        app.delete('/parcels/:id', async (req, res) => {
            try {
                const parcelId = req.params.id;
            
                const result = await parcelCollection.deleteOne({
                    _id: new ObjectId(parcelId),
                });

                return res.send(result);

            } catch (error) {
                res.send({ message: 'Server error', error });
            }
        });

    } finally { }
}
run().catch(console.dir);





app.listen(port, () => {
    console.log(`Profast delivery service listening on port ${port}`)
})



