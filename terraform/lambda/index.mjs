import { ECSClient, DescribeServicesCommand, UpdateServiceCommand, DescribeTaskDefinitionCommand } from "@aws-sdk/client-ecs";
import { CloudWatchLogsClient, FilterLogEventsCommand, PutLogEventsCommand, CreateLogStreamCommand } from "@aws-sdk/client-cloudwatch-logs";
import { CostExplorerClient, GetCostAndUsageCommand } from "@aws-sdk/client-cost-explorer";
import { CloudFrontClient, GetDistributionCommand, ListInvalidationsCommand } from "@aws-sdk/client-cloudfront";
import { S3Client, HeadBucketCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { ECRClient, DescribeImagesCommand } from "@aws-sdk/client-ecr";
import { RDSClient, StopDBInstanceCommand, StartDBInstanceCommand, DescribeDBInstancesCommand } from "@aws-sdk/client-rds";
import { ElasticLoadBalancingV2Client, DeleteLoadBalancerCommand, DescribeLoadBalancersCommand } from "@aws-sdk/client-elastic-load-balancing-v2";

const ecs = new ECSClient({ region: "us-east-1" });
const cwLogs = new CloudWatchLogsClient({ region: "us-east-1" });
const ce = new CostExplorerClient({ region: "us-east-1" });
const cf = new CloudFrontClient({ region: "us-east-1" });
const s3 = new S3Client({ region: "us-east-1" });
const ecr = new ECRClient({ region: "us-east-1" });
const rds = new RDSClient({ region: "us-east-1" });
const elbv2 = new ElasticLoadBalancingV2Client({ region: "us-east-1" });

// ── Project definitions (grouped) ──
// Each project contains multiple components: api, frontend, db, infra
// type "external" = health-checked via HTTP (Railway, Vercel, Supabase)
const PROJECTS = [
  // ── LeadBridge Production (Vercel + Railway + Supabase) ──
  {
    id: "leadbridge-prod",
    name: "LeadBridge",
    env: "production",
    stack: "Vercel + Railway + Supabase",
    description: "Lead management platform",
    components: [
      { id: "frontend", label: "Frontend", type: "external", provider: "vercel", healthUrl: "https://www.leadbridge360.com", publicUrl: "https://www.leadbridge360.com", ghRepo: "goscha01/geos-leadbridge", ghBranch: "main", vercelProjectId: "prj_KtaLcKdg5Mo5K8zzNtsC9CpN5ifp" },
      { id: "api", label: "API", type: "external", provider: "railway", healthUrl: "https://thumbtack-bridge-production.up.railway.app/api/health", publicUrl: "https://thumbtack-bridge-production.up.railway.app", ghRepo: "goscha01/geos-leadbridge", ghBranch: "main", railwayServiceId: "d59d2d4c-816a-4639-9687-8e0ec7b487cf" },
      { id: "db", label: "Database", type: "external", provider: "supabase", healthUrl: "https://eeeipuztpbubslsxcpew.supabase.co/rest/v1/", publicUrl: "https://supabase.com/dashboard", note: "Supabase hosted PostgreSQL" },
    ],
    costServices: [],
  },
  // ── LeadBridge Staging (AWS) ──
  {
    id: "leadbridge-staging",
    name: "LeadBridge",
    env: "staging",
    stack: "AWS",
    description: "Lead management platform",
    components: [
      { id: "api", label: "API", type: "ecs", cluster: "leadbridge-prod-cluster", service: "leadbridge-prod-backend", logGroup: "/ecs/leadbridge-prod", ecrRepo: "leadbridge-prod-backend", ghRepo: "goscha01/geos-leadbridge", ghBranch: "staging" },
      { id: "frontend", label: "Frontend", type: "static", bucket: "leadbridge-prod-frontend", cloudfrontId: "E36POMA3LQY9BG" },
      { id: "db", label: "Database", type: "rds", rdsInstance: "leadbridge-prod-db", awsService: "Amazon Relational Database Service" },
      { id: "infra", label: "Infrastructure", type: "managed", awsServices: ["Amazon Elastic Load Balancing", "Amazon Virtual Private Cloud", "AWS WAF", "AWS Secrets Manager"] },
    ],
    costServices: [
      "Amazon Elastic Container Service",
      "Amazon Relational Database Service",
      "Amazon Elastic Load Balancing",
      "Amazon Virtual Private Cloud",
      "AWS WAF",
      "AWS Secrets Manager",
      "Amazon Simple Storage Service",
      "Amazon CloudFront",
    ],
  },
  // ── Sigcore Production (Railway + Supabase) ──
  {
    id: "sigcore-prod",
    name: "Sigcore",
    env: "production",
    stack: "Railway + Supabase",
    description: "Telephony middleware (SMS, calls)",
    components: [
      { id: "api", label: "API", type: "external", provider: "railway", healthUrl: "https://sigcore-production.up.railway.app/health", publicUrl: "https://sigcore-production.up.railway.app", ghRepo: "goscha01/Sigcore", ghBranch: "main", railwayServiceId: "e4e089c0-2652-4130-a2f8-ac61a55eef3c" },
      { id: "frontend", label: "Frontend", type: "external", provider: "vercel", healthUrl: "https://sigcore-eight.vercel.app", publicUrl: "https://sigcore-eight.vercel.app", ghRepo: "goscha01/Sigcore", ghBranch: "staging", vercelProjectId: "prj_jd69vnwStaMniisy1eGy93NcnrjU" },
      { id: "db", label: "Database", type: "external", provider: "supabase", healthUrl: "https://eeeipuztpbubslsxcpew.supabase.co/rest/v1/", publicUrl: "https://supabase.com/dashboard", note: "Supabase hosted PostgreSQL (shared)" },
    ],
    costServices: [],
  },
  // ── Sigcore Staging (AWS) ──
  {
    id: "sigcore-staging",
    name: "Sigcore",
    env: "staging",
    stack: "AWS",
    description: "Telephony middleware (SMS, calls)",
    components: [
      { id: "api", label: "API", type: "ecs", cluster: "sigcore-prod-cluster", service: "sigcore-prod-backend", logGroup: "/ecs/sigcore-prod", ecrRepo: "sigcore-prod-backend", ghRepo: "goscha01/Sigcore", ghBranch: "main" },
      { id: "db", label: "Database", type: "rds", rdsInstance: "sigcore-prod-db", awsService: "Amazon Relational Database Service" },
      { id: "infra", label: "Infrastructure", type: "managed", awsServices: ["EC2 - Other"] },
    ],
    costServices: ["Amazon Elastic Container Service", "Amazon Relational Database Service", "EC2 - Other"],
  },
  {
    id: "checkcapture",
    name: "CheckCapture",
    env: "production",
    description: "Check processing & verification",
    components: [
      { id: "api", label: "API", type: "ecs", cluster: "checkcapture-prod-cluster", service: "checkcapture-prod-backend", logGroup: "/ecs/checkcapture-prod", ecrRepo: "checkcapture-prod-backend", ghRepo: "goscha01/CheckCapture", ghBranch: "main" },
      { id: "frontend", label: "Admin Panel", type: "static", bucket: "checkcapture-prod-admin-dashboard" },
      { id: "mobile-ios", label: "iOS App", type: "placeholder", note: "Not yet published to App Store" },
      { id: "mobile-android", label: "Android App", type: "placeholder", note: "Not yet published to Play Store" },
      { id: "db", label: "Database", type: "rds", rdsInstance: "checkcapture-prod-db", awsService: "Amazon Relational Database Service" },
      { id: "infra", label: "Infrastructure", type: "managed", awsServices: ["Amazon Elastic Load Balancing"], albName: "checkcapture-prod-alb" },
    ],
    costServices: ["Amazon Elastic Container Service", "Amazon Relational Database Service", "Amazon Elastic Load Balancing"],
  },
  {
    id: "spotless-homes",
    name: "Spotless Homes",
    env: "production",
    description: "Cleaning service website",
    components: [
      { id: "frontend", label: "Frontend", type: "static", bucket: "www.spotless.homes" },
    ],
    costServices: [],
  },
  {
    id: "geos-landing",
    name: "Geos Website",
    env: "production",
    description: "Company landing page & admin",
    components: [
      { id: "frontend", label: "Frontend", type: "static", bucket: "www.geos-ai.com", cloudfrontId: "E2C37J0OR4UFLY" },
    ],
    costServices: [],
  },
  // ── Callio (Railway + Vercel) ──
  {
    id: "callio-prod",
    name: "Callio",
    env: "production",
    stack: "Railway + Vercel",
    description: "AI calling platform",
    components: [
      { id: "api", label: "API", type: "external", provider: "railway", healthUrl: "https://callio-production-47ac.up.railway.app/health", publicUrl: "https://callio-production-47ac.up.railway.app", ghRepo: "goscha01/Callio", ghBranch: "main", railwayServiceId: "d18a3449" },
      { id: "whatsapp", label: "WhatsApp", type: "external", provider: "railway", healthUrl: "https://callio-production-8d5a.up.railway.app/health", publicUrl: "https://callio-production-8d5a.up.railway.app", ghRepo: "goscha01/Callio", ghBranch: "main", railwayServiceId: "0e7fa346" },
      { id: "frontend", label: "Frontend", type: "external", provider: "vercel", healthUrl: "https://callio.vercel.app", publicUrl: "https://callio.vercel.app", ghRepo: "goscha01/Callio", ghBranch: "main", vercelProjectId: "prj_Vaw14xpQRRQFyBdBgd0A0VXXct5E" },
    ],
    costServices: [],
  },
  // ── Service Flow (Railway + Vercel) ──
  {
    id: "serviceflow-prod",
    name: "Service Flow",
    env: "production",
    stack: "Railway + Vercel",
    description: "Service management platform",
    components: [
      { id: "api", label: "Backend", type: "external", provider: "railway", healthUrl: "https://service-flow-backend-production.up.railway.app/health", publicUrl: "https://service-flow-backend-production.up.railway.app", ghRepo: "goscha01/service-flow", ghBranch: "main", railwayServiceId: "eed7aa3a" },
      { id: "frontend-backend", label: "Backend App", type: "external", provider: "vercel", healthUrl: "https://service-flow-backend.vercel.app", publicUrl: "https://service-flow-backend.vercel.app", ghRepo: "goscha01/service-flow", ghBranch: "main", vercelProjectId: "prj_DtinAaF51zBUuJ12UeyLWB5eEuth" },
      { id: "frontend", label: "Frontend App", type: "external", provider: "vercel", healthUrl: "https://service-flow.vercel.app", publicUrl: "https://service-flow.vercel.app", ghRepo: "goscha01/service-flow", ghBranch: "main", vercelProjectId: "prj_xwPakBOp87PO6Mf6hkggvF80Y31R" },
    ],
    costServices: [],
  },
  // ── Post To (Railway + Vercel) ──
  {
    id: "postto-prod",
    name: "Post To",
    env: "production",
    stack: "Railway + Vercel",
    description: "Social media posting tool",
    components: [
      { id: "api", label: "API", type: "external", provider: "railway", healthUrl: "https://self-post-production.up.railway.app/health", publicUrl: "https://self-post-production.up.railway.app", ghRepo: "goscha01/post-to", ghBranch: "main", railwayServiceId: "22c9c38b" },
      { id: "frontend", label: "Frontend", type: "external", provider: "vercel", healthUrl: "https://post-to.vercel.app", publicUrl: "https://post-to.vercel.app", ghRepo: "goscha01/post-to", ghBranch: "main", vercelProjectId: "prj_fqyPfZfqkA7kJXzuKX9iGJub2lDu" },
    ],
    costServices: [],
  },
  // ── Trestle (Vercel only) ──
  {
    id: "trestle-prod",
    name: "Trestle",
    env: "production",
    stack: "Vercel",
    description: "Trestle API application",
    components: [
      { id: "frontend", label: "App", type: "external", provider: "vercel", healthUrl: "https://trestle-api-app.vercel.app", publicUrl: "https://trestle-api-app.vercel.app", ghRepo: "goscha01/trestle-api-app", ghBranch: "main", vercelProjectId: "prj_TQDb81B7XpgLZcDMnKc4zN9Bg5eM" },
    ],
    costServices: [],
  },
  // ── LogHub (Railway) ──
  {
    id: "loghub-prod",
    name: "LogHub",
    env: "production",
    stack: "Railway",
    description: "Centralized logging service",
    components: [
      { id: "api", label: "API", type: "external", provider: "railway", healthUrl: "https://geosloghub-production.up.railway.app/health", publicUrl: "https://geosloghub-production.up.railway.app", ghRepo: "goscha01/geos-loghub", ghBranch: "main", railwayServiceId: "39863ac2" },
    ],
    costServices: [],
  },
  // ── SiteForge / AlexMessenger (Railway + Vercel) ──
  {
    id: "siteforge-prod",
    name: "SiteForge",
    env: "production",
    stack: "Railway + Vercel",
    description: "AI website builder",
    components: [
      { id: "api", label: "API", type: "external", provider: "railway", healthUrl: "https://alexmessenger-production.up.railway.app/health", publicUrl: "https://alexmessenger-production.up.railway.app", ghRepo: "goscha01/AlexMessenger", ghBranch: "main", railwayServiceId: "487c47bc" },
      { id: "frontend", label: "Frontend", type: "external", provider: "vercel", healthUrl: "https://alexmessenger.vercel.app", publicUrl: "https://alexmessenger.vercel.app", ghRepo: "goscha01/AlexMessenger", ghBranch: "main", vercelProjectId: "prj_9zgtUMw5GmEjRqOtDWaKujPsbXSm" },
    ],
    costServices: [],
  },
  // ── ProofPix (Railway + Vercel) ──
  {
    id: "proofpix-prod",
    name: "ProofPix",
    env: "production",
    stack: "Railway + Vercel",
    description: "Photo proof & verification",
    components: [
      { id: "api", label: "API", type: "external", provider: "railway", healthUrl: "https://steadfast-blessing-production.up.railway.app/health", publicUrl: "https://steadfast-blessing-production.up.railway.app", ghRepo: "goscha01/ProofPix", ghBranch: "main", railwayServiceId: "24d5af31" },
      { id: "frontend", label: "Frontend", type: "external", provider: "vercel", healthUrl: "https://proofpix.vercel.app", publicUrl: "https://proofpix.vercel.app", ghRepo: "goscha01/ProofPix", ghBranch: "main", vercelProjectId: "prj_8NB7Gmr7fXhqiyV9G7UI5ylC4rkP" },
    ],
    costServices: [],
  },
];

// ── Health checks ──

async function getEcsHealth(cluster, service) {
  try {
    const res = await ecs.send(new DescribeServicesCommand({ cluster, services: [service] }));
    const svc = res.services?.[0];
    if (!svc) return { status: "down", running: 0, desired: 0, lastDeploy: null, deployStatus: "failed", deployProgress: 0, paused: false };

    const running = svc.runningCount || 0;
    const desired = svc.desiredCount || 0;
    const deployments = svc.deployments || [];
    const primary = deployments.find(d => d.status === "PRIMARY") || deployments[0];

    // A rolling update is genuinely active when there are multiple deployments
    // (old DRAINING + new PRIMARY). A single deployment with IN_PROGRESS but
    // running >= desired is just ECS being slow to mark rollout as COMPLETED.
    const hasActiveRollout = deployments.length > 1;
    const anyFailed = deployments.some(d => d.rolloutState === "FAILED");
    const primaryRunning = primary?.runningCount ?? running;
    const primaryDesired = primary?.desiredCount ?? desired;
    const primaryStable = primaryRunning >= primaryDesired && primaryDesired > 0;

    let status = "healthy";
    let deployStatus = "success";
    let deployProgress = 100;

    if (desired === 0) {
      status = "paused";
    } else if (running === 0) {
      status = "down";
    } else if (hasActiveRollout) {
      // Multiple deployments = genuine rolling update
      deployStatus = "in-progress";
      deployProgress = primaryDesired > 0 ? Math.min(100, Math.round((primaryRunning / primaryDesired) * 100)) : 0;
      status = "deploying";
    } else if (!primaryStable && primary?.rolloutState === "IN_PROGRESS") {
      // Single deployment but hasn't reached desired count yet
      deployStatus = "in-progress";
      deployProgress = primaryDesired > 0 ? Math.min(100, Math.round((primaryRunning / primaryDesired) * 100)) : 0;
      status = "deploying";
    } else if (running < desired) {
      status = "degraded";
    }

    if (anyFailed && deployStatus !== "in-progress") {
      deployStatus = "failed";
    }

    // Use the most recent deployment's createdAt for lastDeploy
    const latestDep = deployments[0];
    const taskDefArn = primary?.taskDefinition || null;

    // Get task definition revision
    let taskDefRevision = null;
    if (taskDefArn) {
      try {
        const tdRes = await ecs.send(new DescribeTaskDefinitionCommand({ taskDefinition: taskDefArn }));
        taskDefRevision = tdRes.taskDefinition?.revision || null;
      } catch {}
    }

    return {
      status, running, desired, deployStatus, deployProgress,
      lastDeploy: latestDep?.createdAt?.toISOString() || null,
      deployStarted: primary?.createdAt?.toISOString() || null,
      deployUpdated: primary?.updatedAt?.toISOString() || null,
      taskDefRevision,
      paused: desired === 0,
    };
  } catch (e) {
    console.error(`ECS error ${cluster}/${service}:`, e.message);
    return { status: "down", running: 0, desired: 0, lastDeploy: null, deployStatus: "failed", deployProgress: 0, paused: false };
  }
}

async function getRecentErrors(logGroup) {
  try {
    const now = Date.now();
    const res = await cwLogs.send(new FilterLogEventsCommand({
      logGroupName: logGroup,
      startTime: now - 24 * 60 * 60 * 1000,
      endTime: now,
      filterPattern: '?"ERROR" ?"error" ?"Exception" ?"FATAL"',
      limit: 10,
    }));
    return (res.events || []).map(e => ({
      msg: (e.message || "").substring(0, 200).trim(),
      time: new Date(e.timestamp).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }),
    }));
  } catch {
    return [];
  }
}

async function getCommitSha(ecrRepo) {
  if (!ecrRepo) return null;
  try {
    const res = await ecr.send(new DescribeImagesCommand({
      repositoryName: ecrRepo,
      imageIds: [{ imageTag: "latest" }],
    }));
    const tags = res.imageDetails?.[0]?.imageTags || [];
    // Find the tag that looks like a commit SHA (40 hex chars, not "latest")
    return tags.find(t => t !== "latest" && /^[0-9a-f]{7,40}$/.test(t)) || null;
  } catch {
    return null;
  }
}

async function getStaticHealth(bucket, cloudfrontId) {
  let status = "healthy";
  let deployStatus = "success";
  let deployProgress = 100;
  let lastDeploy = null;
  let deployStarted = null;

  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch (e) {
    if (e.name === "NotFound" || e.$metadata?.httpStatusCode === 404) {
      status = "down"; deployStatus = "failed";
    }
  }

  // Get last modified file in S3 as the real "last deploy" time
  try {
    const listRes = await s3.send(new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 50 }));
    const objects = listRes.Contents || [];
    let newest = null;
    for (const obj of objects) {
      if (obj.LastModified && (!newest || obj.LastModified > newest)) newest = obj.LastModified;
    }
    if (newest) lastDeploy = newest.toISOString();
  } catch {}

  if (cloudfrontId) {
    try {
      const dist = await cf.send(new GetDistributionCommand({ Id: cloudfrontId }));
      if (dist.Distribution?.Status === "InProgress") { status = "deploying"; deployStatus = "in-progress"; }
    } catch {}

    // Check for active CloudFront invalidations (= deploy propagation in progress)
    try {
      const invRes = await cf.send(new ListInvalidationsCommand({ DistributionId: cloudfrontId, MaxItems: "5" }));
      const activeInv = (invRes.InvalidationList?.Items || []).find(i => i.Status === "InProgress");
      if (activeInv && deployStatus !== "failed") {
        status = "deploying";
        deployStatus = "in-progress";
        deployProgress = 50; // Invalidation doesn't report %, show partial
        deployStarted = activeInv.CreateTime?.toISOString() || null;
      }
    } catch {}
  }

  return { status, deployStatus, deployProgress, lastDeploy, deployStarted, paused: false };
}

async function getRdsHealth(rdsInstance) {
  try {
    const res = await rds.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: rdsInstance }));
    const db = res.DBInstances?.[0];
    if (!db) return { status: "down", paused: false };
    const dbStatus = db.DBInstanceStatus; // "available", "stopped", "stopping", "starting", etc.
    if (dbStatus === "available") return { status: "healthy", paused: false, dbStatus };
    if (dbStatus === "stopped") return { status: "paused", paused: true, dbStatus };
    if (dbStatus === "stopping") return { status: "pausing", paused: false, dbStatus };
    if (dbStatus === "starting") return { status: "deploying", paused: false, dbStatus };
    return { status: "degraded", paused: false, dbStatus };
  } catch (e) {
    console.error(`RDS error ${rdsInstance}:`, e.message);
    return { status: "down", paused: false };
  }
}

async function getGitHubLatestCommit(ghRepo, ghBranch) {
  if (!ghRepo) return null;
  try {
    const branch = ghBranch || "main";
    const ghToken = process.env.GITHUB_TOKEN || "";
    const headers = { "User-Agent": "geos-admin-dashboard/1.0", Accept: "application/vnd.github.v3+json" };
    if (ghToken) headers.Authorization = `Bearer ${ghToken}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`https://api.github.com/repos/${ghRepo}/commits/${branch}`, {
      headers,
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const data = await res.json();
    return {
      commitSha: data.sha || null,
      lastDeploy: data.commit?.committer?.date || data.commit?.author?.date || null,
      commitMessage: (data.commit?.message || "").split("\n")[0].substring(0, 80),
    };
  } catch {
    return null;
  }
}

// ── Railway deployment status ──

async function getRailwayDeployStatus(serviceId) {
  const token = process.env.RAILWAY_TOKEN;
  if (!token || !serviceId) return null;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch("https://backboard.railway.com/graphql/v2", {
      method: "POST",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        query: `{ service(id: "${serviceId}") { deployments(first: 1) { edges { node { id status createdAt } } } } }`,
      }),
    });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const data = await res.json();
    const dep = data?.data?.service?.deployments?.edges?.[0]?.node;
    if (!dep) return null;
    // Map Railway statuses to our status model
    const statusMap = {
      SUCCESS: "success", BUILDING: "building", DEPLOYING: "deploying",
      FAILED: "failed", CRASHED: "failed", SLEEPING: "sleeping",
      QUEUED: "queued", INITIALIZING: "building", WAITING: "queued",
      NEEDS_APPROVAL: "queued", REMOVING: "deploying", REMOVED: "success",
    };
    return {
      deployStatus: statusMap[dep.status] || "unknown",
      railwayStatus: dep.status,
      lastDeploy: dep.createdAt,
      deployId: dep.id,
    };
  } catch (e) {
    console.error(`Railway error ${serviceId}:`, e.message);
    return null;
  }
}

// ── Vercel deployment status ──

async function getVercelDeployStatus(projectId) {
  const token = process.env.VERCEL_TOKEN;
  if (!token || !projectId) return null;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`https://api.vercel.com/v6/deployments?projectId=${projectId}&target=production&limit=1`, {
      headers: { "Authorization": `Bearer ${token}` },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const data = await res.json();
    const dep = data?.deployments?.[0];
    if (!dep) return null;
    const statusMap = {
      READY: "success", BUILDING: "building", INITIALIZING: "building",
      QUEUED: "queued", ERROR: "failed", CANCELED: "failed",
    };
    return {
      deployStatus: statusMap[dep.state] || "unknown",
      vercelState: dep.state,
      lastDeploy: dep.created ? new Date(dep.created).toISOString() : null,
      readyAt: dep.ready ? new Date(dep.ready).toISOString() : null,
    };
  } catch (e) {
    console.error(`Vercel error ${projectId}:`, e.message);
    return null;
  }
}

async function getExternalHealth(healthUrl, provider) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const start = Date.now();
    const res = await fetch(healthUrl, {
      method: "GET",
      signal: controller.signal,
      headers: { "User-Agent": "geos-admin-dashboard/1.0" },
    });
    clearTimeout(timeout);
    const latencyMs = Date.now() - start;
    // 401/403 from Supabase REST API means the endpoint is reachable (auth required)
    // Vercel SPAs may return 404 at root — any non-5xx means the server is up
    const ok = res.status >= 200 && res.status < 400;
    const reachable = ok
      || (provider === "supabase" && (res.status === 401 || res.status === 403))
      || (provider === "vercel" && res.status < 500);
    return {
      status: reachable ? "healthy" : "degraded",
      httpStatus: res.status,
      latencyMs,
      provider,
      paused: false,
    };
  } catch (e) {
    return {
      status: "down",
      httpStatus: 0,
      latencyMs: 0,
      provider,
      paused: false,
      error: e.message,
    };
  }
}

async function getMonthlyCost() {
  try {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split("T")[0];
    const today = now.toISOString().split("T")[0];
    if (start === today) return { total: 0, breakdown: {}, dayOfMonth: 1, daysInMonth: 30 };

    const res = await ce.send(new GetCostAndUsageCommand({
      TimePeriod: { Start: start, End: today },
      Granularity: "MONTHLY",
      Metrics: ["UnblendedCost"],
      GroupBy: [{ Type: "DIMENSION", Key: "SERVICE" }],
    }));

    const groups = res.ResultsByTime?.[0]?.Groups || [];
    const breakdown = {};
    let total = 0;
    for (const g of groups) {
      const svc = g.Keys?.[0] || "Other";
      const amt = parseFloat(g.Metrics?.UnblendedCost?.Amount || "0");
      if (amt > 0.01) { breakdown[svc] = Math.round(amt * 100) / 100; total += amt; }
    }

    const dayOfMonth = now.getDate();
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();

    return { total: Math.round(total * 100) / 100, breakdown, dayOfMonth, daysInMonth };
  } catch (e) {
    console.error("Cost error:", e.message);
    return { total: 0, breakdown: {}, dayOfMonth: 1, daysInMonth: 30 };
  }
}

// ── Log to service log group (shows up in Grafana Loki) ──

async function logToService(logGroup, message) {
  const streamName = `geos-admin/${new Date().toISOString().split("T")[0]}`;
  try {
    await cwLogs.send(new CreateLogStreamCommand({ logGroupName: logGroup, logStreamName: streamName }));
  } catch (e) {
    if (e.name !== "ResourceAlreadyExistsException") console.error("CreateLogStream error:", e.message);
  }
  try {
    await cwLogs.send(new PutLogEventsCommand({
      logGroupName: logGroup,
      logStreamName: streamName,
      logEvents: [{ timestamp: Date.now(), message: typeof message === "string" ? message : JSON.stringify(message) }],
    }));
  } catch (e) {
    console.error("PutLogEvents error:", e.message);
  }
}

// ── ECS pause/resume ──

async function setEcsDesiredCount(cluster, service, count) {
  await ecs.send(new UpdateServiceCommand({ cluster, service, desiredCount: count }));
}

// ── Handler ──

export async function handler(event) {
  // CORS is handled by the Lambda Function URL config — do NOT set CORS headers here
  // (duplicate headers cause browsers to reject the response)
  const headers = {
    "Content-Type": "application/json",
  };

  if (event.requestContext?.http?.method === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  const authHeader = event.headers?.authorization || event.headers?.Authorization || "";
  const expectedToken = process.env.ADMIN_TOKEN || "";
  if (expectedToken && authHeader !== `Bearer ${expectedToken}`) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: "Unauthorized" }) };
  }

  const method = event.requestContext?.http?.method || "GET";
  const path = event.rawPath || "/";

  // POST /pause — pause or resume an entire project
  if (method === "POST" && path.includes("/pause")) {
    try {
      const body = JSON.parse(event.body || "{}");
      const { projectId, action } = body; // action: "pause" | "resume"
      const proj = PROJECTS.find(p => p.id === projectId);
      if (!proj) return { statusCode: 404, headers, body: JSON.stringify({ error: "Project not found" }) };

      let affected = 0;

      // Pause/resume ECS services
      const ecsComponents = proj.components.filter(c => c.type === "ecs");
      for (const comp of ecsComponents) {
        const logMsg = JSON.stringify({ event: "service_action", action, projectId, project: proj.name, cluster: comp.cluster, service: comp.service, desiredCount: action === "pause" ? 0 : 1, source: "geos-admin-dashboard" });
        console.log(logMsg);
        await setEcsDesiredCount(comp.cluster, comp.service, action === "pause" ? 0 : 1);
        if (comp.logGroup) await logToService(comp.logGroup, logMsg);
        affected++;
      }

      // Stop/start RDS instances
      const rdsComponents = proj.components.filter(c => c.type === "rds" && c.rdsInstance);
      for (const comp of rdsComponents) {
        const logMsg = JSON.stringify({ event: "rds_action", action, projectId, project: proj.name, rdsInstance: comp.rdsInstance, source: "geos-admin-dashboard" });
        console.log(logMsg);
        try {
          if (action === "pause") {
            await rds.send(new StopDBInstanceCommand({ DBInstanceIdentifier: comp.rdsInstance }));
          } else {
            await rds.send(new StartDBInstanceCommand({ DBInstanceIdentifier: comp.rdsInstance }));
          }
          affected++;
        } catch (e) {
          // RDS may already be in the target state
          console.log(`RDS ${action} ${comp.rdsInstance}: ${e.message}`);
        }
        // Log to ECS log group if available
        const ecsComp = ecsComponents[0];
        if (ecsComp?.logGroup) await logToService(ecsComp.logGroup, logMsg);
      }

      // Delete/recreate ALBs (managed components with albName)
      const albComponents = proj.components.filter(c => c.albName);
      for (const comp of albComponents) {
        const logMsg = JSON.stringify({ event: "alb_action", action, projectId, project: proj.name, albName: comp.albName, source: "geos-admin-dashboard" });
        console.log(logMsg);
        try {
          if (action === "pause") {
            // Look up ALB ARN by name, then delete it
            const albRes = await elbv2.send(new DescribeLoadBalancersCommand({ Names: [comp.albName] }));
            const albArn = albRes.LoadBalancers?.[0]?.LoadBalancerArn;
            if (albArn) {
              await elbv2.send(new DeleteLoadBalancerCommand({ LoadBalancerArn: albArn }));
              affected++;
              console.log(`ALB deleted: ${comp.albName}`);
            }
          } else {
            // Resume: ALB must be recreated via terraform apply
            console.log(`ALB ${comp.albName} needs terraform apply to recreate`);
          }
        } catch (e) {
          console.log(`ALB ${action} ${comp.albName}: ${e.message}`);
        }
        if (ecsComponents[0]?.logGroup) await logToService(ecsComponents[0].logGroup, logMsg);
      }

      const resumeNote = action === "resume" && albComponents.length > 0
        ? " Note: ALB needs `terraform apply` to recreate."
        : "";
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, projectId, action, affected, note: resumeNote || undefined }) };
    } catch (e) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
    }
  }

  // GET / — dashboard data
  try {
    const costData = await getMonthlyCost();
    const { dayOfMonth, daysInMonth } = costData;

    const projectResults = await Promise.all(PROJECTS.map(async (proj) => {
      // Resolve each component in parallel
      const componentResults = await Promise.all(proj.components.map(async (comp) => {
        if (comp.type === "ecs") {
          const [health, errors, commitSha] = await Promise.all([
            getEcsHealth(comp.cluster, comp.service),
            getRecentErrors(comp.logGroup),
            getCommitSha(comp.ecrRepo),
          ]);
          return { ...comp, ...health, commitSha, errors24h: errors.length, recentErrors: errors };
        } else if (comp.type === "static") {
          const health = await getStaticHealth(comp.bucket, comp.cloudfrontId);
          return { ...comp, ...health, errors24h: 0, recentErrors: [] };
        } else if (comp.type === "rds") {
          const health = await getRdsHealth(comp.rdsInstance);
          return { ...comp, ...health, errors24h: 0, recentErrors: [] };
        } else if (comp.type === "external") {
          const queries = [
            getExternalHealth(comp.healthUrl, comp.provider),
            getGitHubLatestCommit(comp.ghRepo, comp.ghBranch),
          ];
          // Fetch real deploy status from Railway or Vercel
          if (comp.railwayServiceId) queries.push(getRailwayDeployStatus(comp.railwayServiceId));
          else if (comp.vercelProjectId) queries.push(getVercelDeployStatus(comp.vercelProjectId));
          else queries.push(Promise.resolve(null));

          const [health, ghInfo, platformDeploy] = await Promise.all(queries);

          // Prefer platform deploy info (Railway/Vercel) over GitHub commit date
          let deployStatus = "success";
          let deployProgress = 100;
          let lastDeploy = ghInfo?.lastDeploy || null;
          let status = health.status;

          if (platformDeploy) {
            lastDeploy = platformDeploy.readyAt || platformDeploy.lastDeploy || lastDeploy;
            const ps = platformDeploy.deployStatus;
            if (ps === "building" || ps === "deploying" || ps === "queued") {
              deployStatus = "in-progress";
              deployProgress = ps === "building" ? 50 : ps === "deploying" ? 80 : 10;
              status = "deploying";
            } else if (ps === "failed") {
              deployStatus = "failed";
              deployProgress = 100;
            } else if (ps === "sleeping") {
              status = "paused";
            }
          }

          return {
            ...comp, ...health, status,
            errors24h: 0, recentErrors: [],
            publicUrl: comp.publicUrl, note: comp.note,
            deployStatus, deployProgress,
            commitSha: ghInfo?.commitSha || null,
            lastDeploy,
            commitMessage: ghInfo?.commitMessage || null,
            railwayStatus: platformDeploy?.railwayStatus || null,
            vercelState: platformDeploy?.vercelState || null,
          };
        } else if (comp.type === "placeholder") {
          return { ...comp, status: "paused", errors24h: 0, recentErrors: [], note: comp.note };
        } else {
          // managed (infra) — check ALB if configured, otherwise healthy
          let infraStatus = "healthy";
          let paused = false;
          if (comp.albName) {
            try {
              const albRes = await elbv2.send(new DescribeLoadBalancersCommand({ Names: [comp.albName] }));
              const alb = albRes.LoadBalancers?.[0];
              if (!alb) { infraStatus = "paused"; paused = true; }
            } catch (e) {
              // ALB not found = deleted (paused)
              if (e.name === "LoadBalancerNotFoundException" || e.message?.includes("not found")) {
                infraStatus = "paused"; paused = true;
              }
            }
          }
          return { ...comp, status: infraStatus, paused, errors24h: 0, recentErrors: [] };
        }
      }));

      // Project-level cost: sum matching AWS services
      let projectCostMtd = 0;
      const componentCosts = {};
      for (const svcName of (proj.costServices || [])) {
        const amt = costData.breakdown[svcName] || 0;
        projectCostMtd += amt;
        // Map to component
        for (const comp of proj.components) {
          if ((comp.type === "managed" || comp.type === "rds") && comp.awsService === svcName) {
            componentCosts[comp.id] = (componentCosts[comp.id] || 0) + amt;
          } else if (comp.type === "managed" && comp.awsServices?.includes(svcName)) {
            componentCosts[comp.id] = (componentCosts[comp.id] || 0) + amt;
          }
        }
      }
      // Assign ECS cost proportionally to api components
      const ecsTotal = costData.breakdown["Amazon Elastic Container Service"] || 0;
      const ecsComps = proj.components.filter(c => c.type === "ecs");
      if (ecsComps.length > 0) {
        // Split ECS cost evenly across all ECS projects (3 clusters)
        const allEcsProjects = PROJECTS.filter(p => p.components.some(c => c.type === "ecs")).length;
        const share = ecsTotal / allEcsProjects;
        for (const ec of ecsComps) { componentCosts[ec.id] = Math.round(share * 100) / 100; }
      }
      // Static: S3 + CF split
      const staticComps = proj.components.filter(c => c.type === "static");
      if (staticComps.length > 0) {
        const s3Cost = costData.breakdown["Amazon Simple Storage Service"] || 0;
        const cfCost = costData.breakdown["Amazon CloudFront"] || 0;
        const allStaticProjects = PROJECTS.filter(p => p.components.some(c => c.type === "static")).length;
        const share = (s3Cost + cfCost) / allStaticProjects;
        for (const sc of staticComps) { componentCosts[sc.id] = Math.round(share * 100) / 100; }
      }

      projectCostMtd = Math.round(projectCostMtd * 100) / 100;

      // Overall project status: worst of all components
      // Managed/placeholder/static components are neutral for pause detection —
      // only ECS/RDS/external (actual services) determine if the project is "paused".
      const activeComps = componentResults.filter(c => c.type === "ecs" || c.type === "static" || c.type === "rds" || c.type === "external");
      const statuses = activeComps.length > 0 ? activeComps.map(c => c.status) : componentResults.map(c => c.status);
      // Service components (ECS + RDS + external) — if all are paused, project is paused
      // even if static buckets or managed infra are still "healthy"
      const serviceComps = componentResults.filter(c => c.type === "ecs" || c.type === "rds" || c.type === "external");
      const serviceStatuses = serviceComps.map(c => c.status);
      let projectStatus = "healthy";
      if (serviceStatuses.length > 0 && serviceStatuses.every(s => s === "paused" || s === "pausing")) projectStatus = serviceStatuses.some(s => s === "pausing") ? "pausing" : "paused";
      else if (statuses.includes("down")) projectStatus = "down";
      else if (statuses.includes("degraded")) projectStatus = "degraded";
      else if (statuses.includes("deploying") || statuses.includes("pausing")) projectStatus = "deploying";

      // Forecast: if paused, costs stop — forecast = MTD (no further spend)
      // Otherwise, linear projection from MTD
      const isPaused = projectStatus === "paused" || projectStatus === "pausing";
      const forecast = isPaused
        ? projectCostMtd
        : (dayOfMonth > 1 ? Math.round((projectCostMtd / (dayOfMonth - 1)) * daysInMonth * 100) / 100 : 0);

      const totalErrors = componentResults.reduce((n, c) => n + (c.errors24h || 0), 0);

      return {
        id: proj.id,
        name: proj.name,
        env: proj.env,
        stack: proj.stack,
        description: proj.description,
        status: projectStatus,
        costMtd: projectCostMtd,
        costForecast: forecast,
        errors24h: totalErrors,
        components: componentResults.map(c => ({
          id: c.id,
          label: c.label,
          type: c.type,
          status: c.status || "healthy",
          costMtd: componentCosts[c.id] || 0,
          errors24h: c.errors24h || 0,
          recentErrors: c.recentErrors || [],
          running: c.running,
          desired: c.desired,
          deployStatus: c.deployStatus,
          deployProgress: c.deployProgress,
          lastDeploy: c.lastDeploy,
          deployStarted: c.deployStarted,
          deployUpdated: c.deployUpdated,
          taskDefRevision: c.taskDefRevision,
          commitSha: c.commitSha,
          ghRepo: c.ghRepo,
          ghBranch: c.ghBranch,
          paused: c.paused,
          dbStatus: c.dbStatus,
          note: c.note,
          provider: c.provider,
          publicUrl: c.publicUrl,
          httpStatus: c.httpStatus,
          latencyMs: c.latencyMs,
        })),
      };
    }));

    const totalCost = Math.round(costData.total * 100) / 100;
    const totalForecast = dayOfMonth > 1
      ? Math.round((costData.total / (dayOfMonth - 1)) * daysInMonth * 100) / 100
      : 0;

    return {
      statusCode: 200, headers,
      body: JSON.stringify({
        projects: projectResults,
        cost: { total: totalCost, forecast: totalForecast, breakdown: costData.breakdown, dayOfMonth, daysInMonth },
        timestamp: new Date().toISOString(),
      }),
    };
  } catch (e) {
    console.error("Handler error:", e);
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
}
