import { ECSClient, DescribeServicesCommand, UpdateServiceCommand } from "@aws-sdk/client-ecs";
import { CloudWatchLogsClient, FilterLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { CostExplorerClient, GetCostAndUsageCommand } from "@aws-sdk/client-cost-explorer";
import { CloudFrontClient, GetDistributionCommand } from "@aws-sdk/client-cloudfront";
import { S3Client, HeadBucketCommand } from "@aws-sdk/client-s3";

const ecs = new ECSClient({ region: "us-east-1" });
const cwLogs = new CloudWatchLogsClient({ region: "us-east-1" });
const ce = new CostExplorerClient({ region: "us-east-1" });
const cf = new CloudFrontClient({ region: "us-east-1" });
const s3 = new S3Client({ region: "us-east-1" });

// ── Project definitions (grouped) ──
// Each project contains multiple components: api, frontend, db, infra
const PROJECTS = [
  {
    id: "leadbridge",
    name: "LeadBridge",
    description: "Lead management platform",
    components: [
      { id: "api", label: "API", type: "ecs", cluster: "leadbridge-prod-cluster", service: "leadbridge-prod-backend", logGroup: "/ecs/leadbridge-prod" },
      { id: "frontend", label: "Frontend", type: "static", bucket: "leadbridge-prod-frontend", cloudfrontId: "E36POMA3LQY9BG" },
      { id: "db", label: "Database", type: "managed", awsService: "Amazon Relational Database Service" },
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
  {
    id: "sigcore",
    name: "Sigcore",
    description: "Telephony middleware (SMS, calls)",
    components: [
      { id: "api", label: "API", type: "ecs", cluster: "sigcore-prod-cluster", service: "sigcore-prod-backend", logGroup: "/ecs/sigcore-prod" },
      { id: "infra", label: "Infrastructure", type: "managed", awsServices: ["EC2 - Other"] },
    ],
    costServices: ["Amazon Elastic Container Service", "EC2 - Other"],
  },
  {
    id: "checkcapture",
    name: "CheckCapture",
    description: "Check processing & verification",
    components: [
      { id: "api", label: "API", type: "ecs", cluster: "checkcapture-prod-cluster", service: "checkcapture-prod-backend", logGroup: "/ecs/checkcapture-prod" },
      { id: "infra", label: "Infrastructure", type: "managed", awsServices: [] },
    ],
    costServices: ["Amazon Elastic Container Service"],
  },
  {
    id: "geos-landing",
    name: "Geos Website",
    description: "Company landing page & admin",
    components: [
      { id: "frontend", label: "Frontend", type: "static", bucket: "www.geos-ai.com", cloudfrontId: "E2C37J0OR4UFLY" },
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
    const dep = svc.deployments?.[0];

    let status = "healthy";
    let deployStatus = "success";
    let deployProgress = 100;

    if (desired === 0) status = "paused";
    else if (running === 0) status = "down";
    else if (running < desired) status = "degraded";

    if (dep) {
      const rollout = dep.rolloutState;
      if (rollout === "IN_PROGRESS") {
        deployStatus = "in-progress";
        deployProgress = desired > 0 ? Math.min(100, Math.round((running / desired) * 100)) : 0;
        status = "deploying";
      } else if (rollout === "FAILED") {
        deployStatus = "failed";
      }
    }

    return {
      status, running, desired, deployStatus, deployProgress,
      lastDeploy: dep?.createdAt?.toISOString() || null,
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

async function getStaticHealth(bucket, cloudfrontId) {
  let status = "healthy";
  let deployStatus = "success";
  let lastDeploy = null;

  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch (e) {
    if (e.name === "NotFound" || e.$metadata?.httpStatusCode === 404) {
      status = "down"; deployStatus = "failed";
    }
  }

  if (cloudfrontId) {
    try {
      const dist = await cf.send(new GetDistributionCommand({ Id: cloudfrontId }));
      if (dist.Distribution?.Status === "InProgress") { status = "deploying"; deployStatus = "in-progress"; }
      lastDeploy = dist.Distribution?.LastModifiedTime?.toISOString() || null;
    } catch {}
  }

  return { status, deployStatus, deployProgress: 100, lastDeploy, paused: false };
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

      const ecsComponents = proj.components.filter(c => c.type === "ecs");
      for (const comp of ecsComponents) {
        await setEcsDesiredCount(comp.cluster, comp.service, action === "pause" ? 0 : 1);
      }

      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, projectId, action, affected: ecsComponents.length }) };
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
          const [health, errors] = await Promise.all([
            getEcsHealth(comp.cluster, comp.service),
            getRecentErrors(comp.logGroup),
          ]);
          return { ...comp, ...health, errors24h: errors.length, recentErrors: errors };
        } else if (comp.type === "static") {
          const health = await getStaticHealth(comp.bucket, comp.cloudfrontId);
          return { ...comp, ...health, errors24h: 0, recentErrors: [] };
        } else {
          // managed (db, infra) — always healthy if the parent ECS is running
          return { ...comp, status: "healthy", errors24h: 0, recentErrors: [] };
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
          if (comp.type === "managed" && comp.awsService === svcName) {
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
      // Forecast: linear projection
      const forecast = dayOfMonth > 1
        ? Math.round((projectCostMtd / (dayOfMonth - 1)) * daysInMonth * 100) / 100
        : 0;

      // Overall project status: worst of all components
      const statuses = componentResults.map(c => c.status);
      let projectStatus = "healthy";
      if (statuses.includes("down")) projectStatus = "down";
      else if (statuses.includes("degraded")) projectStatus = "degraded";
      else if (statuses.includes("deploying")) projectStatus = "deploying";
      else if (statuses.every(s => s === "paused")) projectStatus = "paused";

      const totalErrors = componentResults.reduce((n, c) => n + (c.errors24h || 0), 0);

      return {
        id: proj.id,
        name: proj.name,
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
          paused: c.paused,
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
