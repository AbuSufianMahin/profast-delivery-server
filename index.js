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

        const verifyAdmin = async (req, res, next) => {
            const email = req.decoded.email;
            const user = await userCollection.findOne({ email });

            if (!user || user.role !== "admin") {
                return res.status(403).send({ message: "Forbidden Access" })
            }
            next();
        }

        app.get('/users/search', verifyFBToken, verifyAdmin, async (req, res) => {
            try {
                const { email } = req.query;
                if (!email || email.trim() === '') {
                    return res.status(400).send({ message: 'Query parameter is required' });
                }

                const regex = new RegExp(email, 'i'); // case-insensitive partial match
                const users = await userCollection.find({ email: { $regex: regex } }).limit(10).toArray();
                res.send(users);

            } catch (error) {
                res.status(500).send({ message: 'Internal Server Error' });
            }
        });

        // search user role by email address
        app.get("/users/:email/role", async (req, res) => {
            try {
                const email = req.params.email;
                const user = await userCollection.findOne({ email: email });

                if (!user) {
                    return res.status(404).send({ message: "User not found" });
                }

                res.send({ role: user.role });
            } catch (error) {
                res.status(500).send({ message: "Internal server error" });
            }


        })

        app.patch('/users/:userId/role', verifyFBToken, verifyAdmin, async (req, res) => {
            const userId = req.params.userId;
            const { role } = req.body;


            try {
                const result = await userCollection.updateOne(
                    { _id: new ObjectId(userId) },
                    { $set: { role } }
                );
                res.status(200).send(result);

            } catch (error) {
                res.status(500).send({ success: false, error: error.message });
            }

        })

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
                let parcelQuery = {};
                let options = {};

                // req.query of this api will have either email or delivery_status and payment_status together
                if (req.query.email) {
                    parcelQuery["senderDetails.email"] = req.query.email;
                    options.sort = { 'parcelDetails.createdAt': -1 }
                }
                else {

                    parcelQuery["parcelDetails.delivery_status"] = req.query.delivery_status;
                    parcelQuery["parcelDetails.payment_status"] = req.query.payment_status;

                }

                const result = await parcelCollection.find(parcelQuery, options).toArray();
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

        app.get('/rider/assigned-parcel', async (req, res) => {
            const { email } = req.query;

            if (!email) {
                return res.status(400).json({ error: 'Email query parameter is required.' });
            }

            try {
                const rider = await riderCollection.findOne({ riderEmail: email });

                if (!rider) {
                    return res.status(404).json({ error: 'Rider not found.' });
                }
                const assignedParcelObjectIds = rider.assignedParcels.map(id => new ObjectId(id))

                const assignedParcels = await parcelCollection.find({ _id: { $in: assignedParcelObjectIds } }).toArray();
                res.send(assignedParcels);

            } catch (error) {
                res.status(500).send({ error: 'Internal server error' });
            }
        });

        app.patch('/parcels/status/:trackingId', async (req, res) => {
            const trackingId = req.params.trackingId;
            const { status } = req.body;

            try {
                const result = await parcelCollection.updateOne(
                    { "parcelDetails.trackingId": trackingId },
                    { $set: { "parcelDetails.delivery_status": status } }
                );

                if (result.matchedCount === 0) {
                    return res.status(404).send({ error: "Parcel not found." });
                }
                res.send(result); 
            } catch (err) {
                res.status(500).send({ error: "Internal server error", details: err.message });
            }
        });

        app.get('/riders/pending', verifyFBToken, verifyAdmin, async (req, res) => {
            try {
                const pendingRiders = await riderCollection.find({ status: 'pending' }).toArray();
                res.status(200).send(pendingRiders);

            } catch (error) {
                res.status(500).send({ message: error.message || 'Internal Server Error' });
            }
        });

        app.patch('/rider/:riderId/status', verifyFBToken, verifyAdmin, async (req, res) => {
            try {
                const riderId = req.params.riderId
                const { riderEmail, status } = req.body

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

        app.get('/riders/active', verifyFBToken, verifyAdmin, async (req, res) => {
            try {
                const activeRiders = await riderCollection.find({ status: "Approved" }).toArray();
                res.send(activeRiders);
            } catch (error) {
                res.status(500).send({ message: "Internal Server Error" });
            }
        });

        app.get('/riders/available', async (req, res) => {
            try {

                const { city, area } = req.query;

                const query = {
                    status: 'Approved',
                    $or: [
                        { assignedParcels: { $exists: false } },
                        { assignedParcels: { $size: 0 } },
                        { assignedParcels: { $not: { $size: 5 } } }
                    ]
                };

                if (city) query.riderCity = city;
                if (area) query.riderWarehouse = area;

                const riders = await riderCollection.find(query).toArray();
                res.status(200).send(riders);

            } catch (err) {
                res.status(500).send({ message: 'Server error fetching riders' });
            }
        });

        app.patch('/parcels/:parcelId/assign-rider', async (req, res) => {
            try {
                const parcelId = req.params.parcelId;
                const rider = req.body.rider;
                console.log(parcelId);

                const parcelQuery = { _id: new ObjectId(parcelId) };

                const parcelRes = await parcelCollection.updateOne(
                    parcelQuery,
                    {
                        $set: {
                            assignedRider: {
                                riderName: rider.riderName,
                                riderEmail: rider.riderEmail,
                                riderContact: rider.riderContact,
                                assignedAt: new Date().toISOString()
                            },
                            "parcelDetails.delivery_status": "rider_assigned"
                        },
                    }
                );


                const riderQuery = { _id: new ObjectId(rider._id) }

                const riderRes = await riderCollection.updateOne(riderQuery, {
                    $push: {
                        assignedParcels: new ObjectId(parcelId)
                    }
                })

                res.send(parcelRes);
            }
            catch (error) {
                res.status(500).send({ error: "Server error assigning rider" });
            }
        })



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