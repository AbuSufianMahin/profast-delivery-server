const express = require('express');
const app = express();
const port = process.env.PORT || 3000;
const cors = require('cors');
require('dotenv').config();
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const admin = require("firebase-admin");
const stripe = require('stripe')(process.env.PAYMENT_GATEWAY_KEY);

// middlewire
app.use(cors());
app.use(express.json());

// Firebase Admin SDK
const serviceAccount = require("./profast-firebase-adminsdk.json");

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});


// =====================================================================Mongo DB================================================================
app.get('/', (req, res) => {
    res.send('Profast Delivery service is running')
})

const uri = `mongodb+srv://${process.env.PROFASTDB_ADMIN_USERNAME}:${process.env.PROFASTDB_ADMIN_PASS}@cluster0.udgfocl.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

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

        const db = client.db("profast_delivery_db");

        const userCollection = db.collection("users");
        const parcelCollection = db.collection("parcels");
        const paymentCollection = db.collection("payments");

        const riderCollection = db.collection("riders");

        // custom middlewires
        const verifyFBToken = async (req, res, next) => {

            const authHeader = req.headers.authorization;
            if (!authHeader) {
                return res.status(401).send({ message: "Unauthorized Access" })
            }

            const token = authHeader.split(" ")[1];

            if (!token) {
                console.log("HERE in !token")
                return res.status(401).send({ message: "Unauthorized Access" })
            }

            try {
                const decoded = await admin.auth().verifyIdToken(token);
                req.decoded = decoded;
                next();
            }
            catch {
                return res.status(403).send({ message: "Forbidden Access" })
            }


        }

        app.post("/users", async (req, res) => {
            const email = req.body.email;
            const userExists = await userCollection.findOne({ email });

            if (userExists) {
                // update last logged in

                const result = await userCollection.updateOne(
                    { email },
                    {
                        $set: { last_log_in: new Date().toISOString() }
                    }
                )

                return res.status(200).send({ message: "User Already exists", inserted: false })
            }
            else {
                const userDetails = req.body;

                const result = await userCollection.insertOne(userDetails);
                res.send(result);
            }
        })

        app.get('/parcels', verifyFBToken, async (req, res) => {

            try {
                const userEmail = req.query.email;
                const query = userEmail ? { 'senderDetails.email': userEmail } : {};
                const options = {
                    sort: { 'parcelDetails.createdAt': -1 }
                }

                const result = await parcelCollection.find(query, options).toArray();
                console.log(result);
                res.send(result);
            }
            catch (error) {
                res.status(500).send({ message: 'Error Fetching parcels', error });
            }
        })

        // getting parcel data with mongoDB ObjectId of parcels (not trackingId)
        app.get('/parcels/:parcelId', async (req, res) => {
            const { parcelId } = req.params;
            try {
                const parcels = await parcelCollection.findOne({ _id: new ObjectId(parcelId) })
                res.send(parcels);

            } catch (error) {
                res.status(500).send({ message: 'Server error' });
            }
        });



        app.get('/payments', async (req, res) => {
            const { email } = req.query;
            try {
                const query = email ? { 'payerEmail': email } : {};
                const payments = await paymentCollection.find(query).sort({ paidAt: -1 }).toArray();

                res.status(200).send(payments);
            } catch (err) {
                res.status(500).send({
                    message: 'Failed to fetch payment history',
                    error: err.message,
                });
            }
        });

        app.post('/payments', async (req, res) => {
            const paymentData = req.body;

            try {
                // Update parcel payment_status to 'paid'
                const updateQuery = { _id: new ObjectId(paymentData.parcelId) }
                const updateResult = await parcelCollection.updateOne(updateQuery,
                    {
                        $set: { 'parcelDetails.payment_status': 'paid' }
                    }
                );

                // add payment history
                const paymentResult = await paymentCollection.insertOne(paymentData);

                console.log(paymentResult);
                res.send(paymentResult);

            } catch (error) {
                res.status(500).json({ message: 'Server error', error: error.message });
            }
        })

        app.post('/add-parcel', async (req, res) => {
            try {
                const parcelData = req.body;
                const result = await parcelCollection.insertOne(parcelData);
                res.status(200).send(result);
            } catch (error) {
                res.status(500).send({ error: "Failed to add parcel" });
            }
        })

        app.get('/riders/pending', async (req, res) => {
            try {
                const pendingRiders = await riderCollection.find({ status: 'pending' }).toArray();
                res.status(200).send(pendingRiders);

            } catch (error) {
                res.status(500).send({ message: error.message || 'Internal Server Error' });
            }
        });

        app.patch('/rider/status', async (req, res) => {
            try {
                const { riderId, riderEmail, status } = req.body

                const filter = { _id: new ObjectId(riderId) }
                const updateDoc = {
                    $set: {
                        status,
                        updated_at: new Date().toISOString(),
                    }
                }

                const riderStatusResult = await riderCollection.updateOne(filter, updateDoc);

                // update the role => "user" to "rider" in userCollection
                if (status == "Approved") {
                    await userCollection.updateOne(
                        { email: riderEmail },
                        {
                            $set: {
                                role: 'rider',
                                role_updated_at: new Date().toISOString(),
                            },
                        }
                    );
                }

                return res.send(riderStatusResult);
            }
            catch {
                return res.status(500).send({ message: 'Internal Server Error' });
            }
        })

        app.get('/riders/active', async (req, res) => {
            try {
                const activeRiders = await riderCollection.find({ status: "Approved" }).toArray();
                res.send(activeRiders);
            } catch (error) {
                res.status(500).send({ message: "Internal Server Error" });
            }
        });

        app.post('/add-riders', async (req, res) => {
            try {
                const riderData = req.body;
                const result = await riderCollection.insertOne(riderData);
                res.send(result);

            } catch (error) {
                res.status(500).send({ error: 'Internal Server Error' });
            }
        });

        // stripe payment intent 
        app.post('/create-payment-intent', async (req, res) => {
            const { amountInCents } = req.body;

            try {
                const paymentIntent = await stripe.paymentIntents.create({
                    amount: amountInCents,
                    currency: 'usd',
                    payment_method_types: ['card'],
                });

                res.send({ clientSecret: paymentIntent.client_secret });
            }
            catch (err) {
                res.status(500).send({ message: err.message });
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



