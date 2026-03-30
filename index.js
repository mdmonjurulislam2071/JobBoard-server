require("dotenv").config();
const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const jwt = require("jsonwebtoken");
const admin = require("firebase-admin");
const serviceAccount = require("./firebase-admin-key.json");

if (!process.env.JWT_SECRET) {
  console.log( "JWT_SECRET not found in .env, using default for development");
  process.env.JWT_SECRET = "my_super_secret_key_12345";
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const app = express();
const PORT = process.env.PORT || 3000;

app.use(
  cors({
    origin: ["http://localhost:5173", "http://localhost:5174"],
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.use(express.json({ limit: '50mb' }));
app.use(cookieParser());

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.xhq8aqv.mongodb.net/?retryWrites=true&w=majority`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    console.log(" MongoDB connecting...");
    console.log( " JWT_SECRET is set:", process.env.JWT_SECRET ? "Yes" : "No");

    const db = client.db("usersDb");
    const usersCollection = db.collection("usersRole");
    const jobsCollection = db.collection("jobs");
    const applicationsCollection = db.collection("applications");

    console.log(" MongoDB connected successfully");

    const verifyToken = (req, res, next) => {
      const token = req.cookies?.token;
      console.log(" Verifying token:", token ? "Present" : "Not present");

      if (!token) {
        return res.status(401).json({ message: "Unauthorized access - No token" });
      }

      jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
        if (err) {
          console.error("Token verification error:", err);
          return res.status(401).json({ message: "Invalid token" });
        }
        console.log(" Token verified for:", decoded.email);
        req.user = decoded;
        next();
      });
    };

    const verifyRecruiter = async (req, res, next) => {
      try {
        const email = req.user.email;
        console.log(" Checking recruiter for:", email);
        
        const user = await usersCollection.findOne({ email });

        if (!user) {
          return res.status(404).json({ message: "User not found" });
        }

        if (user.role !== "recruiter") {
          return res.status(403).json({ message: "Recruiter access only" });
        }

        console.log(" Recruiter verified:", email);
        next();
      } catch (error) {
        console.error("Recruiter verification error:", error);
        res.status(500).json({ message: "Server error" });
      }
    };

    app.get("/", (req, res) => {
      res.json({ message: "Job Portal Server Running", status: "OK" });
    });

    // ==================== JOBS APIs ====================
    
    app.get("/jobs", async (req, res) => {
      try {
        console.log(" Fetching all jobs from database");
        const allJobs = await jobsCollection.find({}).toArray();
        const jobsWithStringId = allJobs.map(job => ({
          ...job,
          _id: job._id.toString()
        }));
        console.log(" Total jobs found:", jobsWithStringId.length);
        res.json({
          success: true,
          count: jobsWithStringId.length,
          jobs: jobsWithStringId
        });
      } catch (error) {
        console.error(" Error fetching jobs:", error);
        res.status(500).json({ success: false, message: "Failed to fetch jobs" });
      }
    });

    app.get("/jobs/:id", async (req, res) => {
      try {
        const jobId = req.params.id;
        console.log(" Fetching job details for ID:", jobId);
        
        if (!ObjectId.isValid(jobId)) {
          return res.status(400).json({ success: false, message: "Invalid job ID format" });
        }
        
        const job = await jobsCollection.findOne({ _id: new ObjectId(jobId) });
        
        if (!job) {
          return res.status(404).json({ success: false, message: "Job not found" });
        }
        
        const jobWithStringId = { ...job, _id: job._id.toString() };
        res.json({ success: true, job: jobWithStringId });
      } catch (error) {
        console.error(" Error fetching job details:", error);
        res.status(500).json({ success: false, message: "Failed to fetch job details" });
      }
    });

    app.post("/post-job", verifyToken, verifyRecruiter, async (req, res) => {
      try {
        console.log(" Job post request from recruiter:", req.user.email);
        const jobData = req.body;
        
        const finalJobData = {
          companyName: jobData.companyName,
          location: jobData.location,
          jobTitle: jobData.jobTitle,
          description: jobData.description,
          salary: jobData.salary,
          jobType: jobData.jobType,
          companyLogo: jobData.companyLogo,
          postedBy: req.user.email,
          postedAt: new Date(),
          status: "active"
        };

        const result = await jobsCollection.insertOne(finalJobData);
        console.log(" Job posted successfully. Job ID:", result.insertedId);
        
        res.status(201).json({
          success: true,
          message: "Job posted successfully",
          jobId: result.insertedId.toString()
        });
      } catch (error) {
        console.error(" Job post error:", error);
        res.status(500).json({ success: false, message: "Failed to post job" });
      }
    });

    app.get("/my-jobs", verifyToken, async (req, res) => {
      try {
        const email = req.user.email;
        console.log(" Fetching posted jobs for recruiter:", email);
        
        const myJobs = await jobsCollection
          .find({ postedBy: email })
          .sort({ postedAt: -1 })
          .toArray();
        
        const jobsWithCount = await Promise.all(myJobs.map(async (job) => {
          const jobIdStr = job._id.toString();
          const applicationsCount = await applicationsCollection.countDocuments({ jobId: jobIdStr });
          return { ...job, _id: jobIdStr, applicationsCount };
        }));
        
        res.json({ success: true, count: jobsWithCount.length, jobs: jobsWithCount });
      } catch (error) {
        console.error(" Error fetching posted jobs:", error);
        res.status(500).json({ success: false, message: "Failed to fetch posted jobs" });
      }
    });

    app.patch("/my-job/:jobId", verifyToken, async (req, res) => {
      try {
        const jobId = req.params.jobId;
        const { status } = req.body;
        const email = req.user.email;
        
        const job = await jobsCollection.findOne({ 
          _id: new ObjectId(jobId), postedBy: email 
        });
        
        if (!job) {
          return res.status(404).json({ success: false, message: "Job not found or unauthorized" });
        }
        
        await jobsCollection.updateOne(
          { _id: new ObjectId(jobId) },
          { $set: { status: status, updatedAt: new Date() } }
        );
        
        res.json({ success: true, message: `Job status updated to ${status}` });
      } catch (error) {
        console.error(" Error updating job status:", error);
        res.status(500).json({ success: false, message: "Failed to update job status" });
      }
    });

    app.delete("/my-job/:jobId", verifyToken, async (req, res) => {
      try {
        const jobId = req.params.jobId;
        const email = req.user.email;
        
        const job = await jobsCollection.findOne({ 
          _id: new ObjectId(jobId), postedBy: email 
        });
        
        if (!job) {
          return res.status(404).json({ success: false, message: "Job not found or unauthorized" });
        }
        
        await jobsCollection.deleteOne({ _id: new ObjectId(jobId) });
        res.json({ success: true, message: "Job deleted successfully" });
      } catch (error) {
        console.error(" Error deleting job:", error);
        res.status(500).json({ success: false, message: "Failed to delete job" });
      }
    });

    // ==================== APPLICATIONS APIs ====================

    app.post("/applyjob/:jobId", verifyToken, async (req, res) => {
      try {
        const jobId = req.params.jobId;
        const email = req.user.email;
        const { expectedSalary, resumeUrl, resumeFileName } = req.body;
        
        const job = await jobsCollection.findOne({ _id: new ObjectId(jobId) });
        if (!job) {
          return res.status(404).json({ success: false, message: "Job not found" });
        }
        
        const existingApplication = await applicationsCollection.findOne({
          jobId: jobId, applicantEmail: email
        });
        
        if (existingApplication) {
          return res.status(400).json({ success: false, message: "You have already applied for this job" });
        }
        
        const newApplication = {
          jobId: jobId,
          jobTitle: job.jobTitle,
          companyName: job.companyName,
          applicantName: email.split('@')[0],
          applicantEmail: email,
          expectedSalary: expectedSalary,
          resumeUrl: resumeUrl,
          resumeFileName: resumeFileName,
          status: "pending",
          appliedAt: new Date(),
          updatedAt: new Date()
        };
        
        const result = await applicationsCollection.insertOne(newApplication);
        res.status(201).json({ success: true, message: "Application submitted successfully", applicationId: result.insertedId.toString() });
      } catch (error) {
        console.error(" Error submitting application:", error);
        res.status(500).json({ success: false, message: "Failed to submit application" });
      }
    });

    app.get("/my-applications", verifyToken, async (req, res) => {
      try {
        const email = req.user.email;
        const myApplications = await applicationsCollection
          .find({ applicantEmail: email })
          .sort({ appliedAt: -1 })
          .toArray();
        
        const applicationsWithStringId = myApplications.map(app => ({ ...app, _id: app._id.toString() }));
        res.json({ success: true, count: applicationsWithStringId.length, applications: applicationsWithStringId });
      } catch (error) {
        console.error(" Error fetching my applications:", error);
        res.status(500).json({ success: false, message: "Failed to fetch applications" });
      }
    });

    app.get("/job-applications/:jobId", verifyToken, async (req, res) => {
      try {
        const jobId = req.params.jobId;
        const email = req.user.email;
        
        const job = await jobsCollection.findOne({ _id: new ObjectId(jobId), postedBy: email });
        if (!job) {
          return res.status(404).json({ success: false, message: "Job not found or unauthorized" });
        }
        
        const applications = await applicationsCollection
          .find({ jobId: jobId })
          .sort({ appliedAt: -1 })
          .toArray();
        
        const applicationsWithStringId = applications.map(app => ({ ...app, _id: app._id.toString() }));
        res.json({ success: true, count: applicationsWithStringId.length, applications: applicationsWithStringId });
      } catch (error) {
        console.error(" Error fetching applications:", error);
        res.status(500).json({ success: false, message: "Failed to fetch applications" });
      }
    });

    app.patch("/application/:applicationId", verifyToken, async (req, res) => {
      try {
        const applicationId = req.params.applicationId;
        const { status } = req.body;
        const email = req.user.email;
        
        const application = await applicationsCollection.findOne({ _id: new ObjectId(applicationId) });
        if (!application) {
          return res.status(404).json({ success: false, message: "Application not found" });
        }
        
        const job = await jobsCollection.findOne({ _id: new ObjectId(application.jobId), postedBy: email });
        if (!job) {
          return res.status(403).json({ success: false, message: "You don't have permission" });
        }
        
        await applicationsCollection.updateOne(
          { _id: new ObjectId(applicationId) },
          { $set: { status: status, updatedAt: new Date() } }
        );
        
        res.json({ success: true, message: `Application ${status} successfully` });
      } catch (error) {
        console.error(" Error updating application:", error);
        res.status(500).json({ success: false, message: "Failed to update application" });
      }
    });

    // ==================== AUTH APIs ====================

    //  JWT endpoint - login করার সময় JWT তৈরি করে
    app.post("/jwt", async (req, res) => {
      try {
        const { token } = req.body;
        if (!token) return res.status(400).json({ message: "Token is required" });

        const decoded = await admin.auth().verifyIdToken(token);
        
        // Get user role from database
        const user = await usersCollection.findOne({ email: decoded.email });
        
        const jwtToken = jwt.sign(
          { email: decoded.email, uid: decoded.uid, role: user?.role || null },
          process.env.JWT_SECRET,
          { expiresIn: "7d" }
        );

        res.cookie("token", jwtToken, {
          httpOnly: true,
          secure: false,
          sameSite: "lax",
          maxAge: 7 * 24 * 60 * 60 * 1000,
        }).status(200).json({ 
          success: true, 
          message: "JWT created successfully", 
          email: decoded.email,
          role: user?.role || null
        });
      } catch (error) {
        console.error(" JWT error:", error);
        res.status(401).json({ message: "Authentication failed", error: error.message });
      }
    });

    //  Register endpoint - শুধু user save করে, JWT তৈরি করে না
    app.post("/users", async (req, res) => {
      try {
        const user = req.body;
        console.log(" Registering user:", user.email);

        if (!user.email || !user.uid || !user.role) {
          return res.status(400).json({ success: false, message: "Email, UID, and role are required" });
        }

        const exist = await usersCollection.findOne({ email: user.email });
        if (exist) {
          return res.status(400).json({ success: false, message: "User already exists" });
        }

        const result = await usersCollection.insertOne({
          email: user.email,
          uid: user.uid,
          role: user.role,
          createdAt: new Date()
        });

        console.log(" User registered:", user.email);
        
        //  JWT তৈরি না করে শুধু success response
        res.status(201).json({ 
          success: true, 
          message: "User registered successfully. Please login.",
          result 
        });
      } catch (error) {
        console.error(" Registration error:", error);
        res.status(500).json({ success: false, message: "Failed to register user" });
      }
    });

    //  Profile endpoint - JWT থেকে user role ফেরত দেয়
    app.get("/profile", verifyToken, async (req, res) => {
      try {
        const email = req.user.email;
        const user = await usersCollection.findOne({ email });
        
        if (!user) {
          return res.status(404).json({ message: "User not found" });
        }
        
        res.json({ 
          email: user.email, 
          role: user.role, 
          uid: user.uid, 
          createdAt: user.createdAt 
        });
      } catch (error) {
        console.error(" Profile error:", error);
        res.status(500).json({ message: "Server error" });
      }
    });

    //  Get user by UID
    app.get("/users/:uid", async (req, res) => {
      try {
        const uid = req.params.uid;
        const user = await usersCollection.findOne({ uid });
        
        if (!user) {
          return res.status(404).json({ message: "User not found" });
        }
        
        res.json({
          email: user.email,
          role: user.role,
          uid: user.uid
        });
      } catch (error) {
        console.error(" User fetch error:", error);
        res.status(500).json({ message: "Server error" });
      }
    });

    app.post("/logout", (req, res) => {
      res.clearCookie("token", { httpOnly: true, secure: false, sameSite: "lax" })
        .status(200)
        .json({ success: true, message: "Logged out successfully" });
    });

    app.use((req, res) => {
      console.log(" 404 - Route not found:", req.url);
      res.status(404).json({ message: "Route not found" });
    });

  } catch (err) {
    console.error(" MongoDB connection error:", err);
  }
}

run().catch(console.dir);

app.listen(PORT, () => {
  console.log(` Server running on port ${PORT}`);
});