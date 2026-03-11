import { ECSClient, DescribeServicesCommand, ListServicesCommand, DescribeClustersCommand } from "@aws-sdk/client-ecs";
import { CloudWatchClient, GetMetricStatisticsCommand } from "@aws-sdk/client-cloudwatch";
import { CloudWatchLogsClient, FilterLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { CostExplorerClient, GetCostAndUsageCommand } from "@aws-sdk/client-cost-explorer";
import { CloudFrontClient, GetDistributionCommand } from "@aws-sdk/client-cloudfront";
import { S3Client, HeadBucketCommand } from "@aws-sdk/client-s3";

const ecs = new ECSClient({ region: "us-east-1" });
const cw = new CloudWatchClient({ region: "us-east-1" });
const cwLogs = new CloudWatchLogsClient({ region: "us-east-1" });
const ce = new CostExplorerClient({ region: "us-east-1" });
const cf = new CloudFrontClient({ region: "us-east-1" });
const s3 = new S3Client({ region: "us-east-1" });

// Project definitions — maps dashboard projects to AWS resources
const PROJECTS = [
  {
    id: "leadbridge-api",
    name: "LeadBridge API",
    env: "Production  ·  AWS ECS",
    type: "ecs",
    cluster: "leadbridge-prod-cluster",
    service: "leadbridge-prod-backend",
    logGroup: "/ecs/leadbridge-prod",
    costTags: { key: "Project", value: "leadbridge" },
  },
  {
    id: "sigcore-api",
    name: "Sigcore API",
    env: "Production  ·  AWS ECS",
    type: "ecs",
    cluster: "sigcore-prod-cluster",
    service: "sigcore-prod-backend",
    logGroup: "/ecs/sigcore-prod",
    costTags: { key: "Project", value: "sigcore" },
  },
  {
    id: "checkcapture-api",
    name: "CheckCapture API",
    env: "Production  ·  AWS ECS",
    cluster: "checkcapture-prod-cluster",
    service: "checkcapture-prod-backend",
    type: "ecs",
    logGroup: "/ecs/checkcapture-prod",
    costTags: { key: "Project", value: "checkcapture" },
  },
  {
    id: "leadbridge-frontend",
    name: "LeadBridge Frontend",
    env: "Production  ·  AWS S3 + CloudFront",
    type: "static",
    bucket: "leadbridge-prod-frontend",
    cloudfrontId: "E36POMA3LQY9BG",
  },
  {
    id: "geos-landing",
    name: "Geos Landing Page",
    env: "Production  ·  AWS S3 + CloudFront",
    type: "static",
    bucket: "www.geos-ai.com",
    cloudfrontId: "E2C37J0OR4UFLY",
  },
];

// ── Helpers ──

async function getEcsHealth(cluster, service) {
  try {
    const res = await ecs.send(new DescribeServicesCommand({
      cluster,
      services: [service],
    }));
    const svc = res.services?.[0];
    if (!svc) return { status: "down", running: 0, desired: 0, lastDeploy: null, deployStatus: "failed" };

    const running = svc.runningCount || 0;
    const desired = svc.desiredCount || 0;
    const lastDeploy = svc.deployments?.[0];

    let status = "healthy";
    let deployStatus = "success";
    let deployProgress = 100;

    if (desired === 0) {
      status = "paused";
    } else if (running === 0) {
      status = "down";
    } else if (running < desired) {
      status = "degraded";
    }

    if (lastDeploy) {
      const rollout = lastDeploy.rolloutState;
      if (rollout === "IN_PROGRESS") {
        deployStatus = "in-progress";
        // Cap progress at 100% (running can temporarily exceed desired during rolling deploys)
        deployProgress = desired > 0 ? Math.min(100, Math.round((running / desired) * 100)) : 0;
        status = "deploying";
      } else if (rollout === "FAILED") {
        deployStatus = "failed";
      }
    }

    return {
      status,
      running,
      desired,
      deployStatus,
      deployProgress,
      lastDeploy: lastDeploy?.createdAt ? lastDeploy.createdAt.toISOString() : null,
      paused: desired === 0,
    };
  } catch (e) {
    console.error(`ECS error for ${cluster}/${service}:`, e.message);
    return { status: "down", running: 0, desired: 0, lastDeploy: null, deployStatus: "failed", deployProgress: 0, paused: false };
  }
}

async function getRecentErrors(logGroup, hoursBack = 24) {
  try {
    const now = Date.now();
    const start = now - hoursBack * 60 * 60 * 1000;
    const res = await cwLogs.send(new FilterLogEventsCommand({
      logGroupName: logGroup,
      startTime: start,
      endTime: now,
      filterPattern: '?"ERROR" ?"error" ?"Exception" ?"FATAL"',
      limit: 10,
    }));

    const errors = (res.events || []).map(e => ({
      msg: (e.message || "").substring(0, 200).trim(),
      time: new Date(e.timestamp).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }),
    }));

    return { count: errors.length, errors };
  } catch (e) {
    // Log group may not exist
    console.warn(`Log error for ${logGroup}:`, e.message);
    return { count: 0, errors: [] };
  }
}

async function getStaticSiteHealth(bucket, cloudfrontId) {
  let status = "healthy";
  let deployStatus = "success";

  // Check S3 bucket accessibility — HeadBucket needs s3:ListBucket,
  // so fall back to healthy if we get 403 (bucket exists but no list permission)
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch (e) {
    if (e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404) {
      status = "down";
      deployStatus = "failed";
    }
    // 403 = bucket exists but no permission — that's fine, site is up
  }

  // Check CloudFront status
  let lastModified = null;
  if (cloudfrontId) {
    try {
      const dist = await cf.send(new GetDistributionCommand({ Id: cloudfrontId }));
      const cfStatus = dist.Distribution?.Status;
      if (cfStatus === "InProgress") {
        status = "deploying";
        deployStatus = "in-progress";
      }
      lastModified = dist.Distribution?.LastModifiedTime?.toISOString() || null;
    } catch (e) {
      console.warn(`CloudFront error for ${cloudfrontId}:`, e.message);
    }
  }

  return { status, deployStatus, deployProgress: 100, lastDeploy: lastModified, paused: false };
}

async function getMonthlyCost() {
  try {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split("T")[0];
    const today = now.toISOString().split("T")[0];

    // If it's the 1st day of the month, use previous month
    if (startOfMonth === today) {
      const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const endPrev = new Date(now.getFullYear(), now.getMonth(), 0);
      const res = await ce.send(new GetCostAndUsageCommand({
        TimePeriod: { Start: prevMonth.toISOString().split("T")[0], End: endPrev.toISOString().split("T")[0] },
        Granularity: "MONTHLY",
        Metrics: ["UnblendedCost"],
        GroupBy: [{ Type: "DIMENSION", Key: "SERVICE" }],
      }));
      return parseCostResult(res);
    }

    const res = await ce.send(new GetCostAndUsageCommand({
      TimePeriod: { Start: startOfMonth, End: today },
      Granularity: "MONTHLY",
      Metrics: ["UnblendedCost"],
      GroupBy: [{ Type: "DIMENSION", Key: "SERVICE" }],
    }));
    return parseCostResult(res);
  } catch (e) {
    console.error("Cost Explorer error:", e.message);
    return { total: 0, breakdown: {} };
  }
}

function parseCostResult(res) {
  const groups = res.ResultsByTime?.[0]?.Groups || [];
  const breakdown = {};
  let total = 0;
  for (const g of groups) {
    const svc = g.Keys?.[0] || "Other";
    const amount = parseFloat(g.Metrics?.UnblendedCost?.Amount || "0");
    if (amount > 0.01) {
      breakdown[svc] = Math.round(amount * 100) / 100;
      total += amount;
    }
  }
  return { total: Math.round(total * 100) / 100, breakdown };
}

// ── Handler ──

export async function handler(event) {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };

  // Handle CORS preflight
  if (event.requestContext?.http?.method === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  // Simple auth check
  const authHeader = event.headers?.authorization || event.headers?.Authorization || "";
  const expectedToken = process.env.ADMIN_TOKEN || "";
  if (expectedToken && authHeader !== `Bearer ${expectedToken}`) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: "Unauthorized" }) };
  }

  try {
    // Run all queries in parallel
    const [costData, ...projectResults] = await Promise.all([
      getMonthlyCost(),
      ...PROJECTS.map(async (proj) => {
        let health;
        let errorData = { count: 0, errors: [] };

        if (proj.type === "ecs") {
          [health, errorData] = await Promise.all([
            getEcsHealth(proj.cluster, proj.service),
            getRecentErrors(proj.logGroup),
          ]);
        } else {
          health = await getStaticSiteHealth(proj.bucket, proj.cloudfrontId);
        }

        return {
          id: proj.id,
          name: proj.name,
          env: proj.env,
          ...health,
          errors24h: errorData.count,
          recentErrors: errorData.errors,
        };
      }),
    ]);

    // Build cost breakdown per service type
    const costBreakdown = costData.breakdown;
    const ecsCost = costBreakdown["Amazon Elastic Container Service"] || 0;
    const rdsCost = costBreakdown["Amazon Relational Database Service"] || 0;
    const s3Cost = costBreakdown["Amazon Simple Storage Service"] || 0;
    const cfCost = costBreakdown["Amazon CloudFront"] || 0;
    const otherCost = costData.total - ecsCost - rdsCost - s3Cost - cfCost;

    const result = {
      projects: projectResults,
      cost: {
        total: costData.total,
        breakdown: costData.breakdown,
        summary: {
          ecs: ecsCost,
          rds: rdsCost,
          s3: s3Cost,
          cloudfront: cfCost,
          other: Math.round(otherCost * 100) / 100,
        },
      },
      timestamp: new Date().toISOString(),
    };

    return { statusCode: 200, headers, body: JSON.stringify(result) };
  } catch (e) {
    console.error("Handler error:", e);
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
}
