# ── Admin Dashboard API (Lambda + Function URL) ──

resource "random_password" "admin_token" {
  length  = 32
  special = false
}

# IAM Role for Lambda
resource "aws_iam_role" "admin_lambda" {
  name = "geos-admin-dashboard-lambda"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy" "admin_lambda" {
  name = "admin-dashboard-permissions"
  role = aws_iam_role.admin_lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "ECS"
        Effect = "Allow"
        Action = [
          "ecs:DescribeServices",
          "ecs:DescribeClusters",
          "ecs:ListServices",
          "ecs:UpdateService",
        ]
        Resource = "*"
      },
      {
        Sid    = "CloudWatchLogs"
        Effect = "Allow"
        Action = [
          "logs:FilterLogEvents",
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents",
        ]
        Resource = "*"
      },
      {
        Sid    = "CostExplorer"
        Effect = "Allow"
        Action = ["ce:GetCostAndUsage"]
        Resource = "*"
      },
      {
        Sid    = "CloudFront"
        Effect = "Allow"
        Action = ["cloudfront:GetDistribution"]
        Resource = "*"
      },
      {
        Sid    = "S3Read"
        Effect = "Allow"
        Action = ["s3:HeadBucket", "s3:ListBucket"]
        Resource = "*"
      },
    ]
  })
}

# Package Lambda
data "archive_file" "admin_lambda" {
  type        = "zip"
  source_file = "${path.module}/lambda/index.mjs"
  output_path = "${path.module}/lambda/admin-api.zip"
}

# Lambda Function
resource "aws_lambda_function" "admin_api" {
  function_name    = "geos-admin-dashboard"
  role             = aws_iam_role.admin_lambda.arn
  handler          = "index.handler"
  runtime          = "nodejs20.x"
  timeout          = 30
  memory_size      = 256
  filename         = data.archive_file.admin_lambda.output_path
  source_code_hash = data.archive_file.admin_lambda.output_base64sha256

  environment {
    variables = {
      ADMIN_TOKEN = random_password.admin_token.result
    }
  }
}

# Function URL (no API Gateway needed — simpler + free)
resource "aws_lambda_function_url" "admin_api" {
  function_name      = aws_lambda_function.admin_api.function_name
  authorization_type = "NONE"

  cors {
    allow_origins = ["https://www.geos-ai.com", "https://geos-ai.com", "http://localhost:*"]
    allow_methods = ["GET"]
    allow_headers = ["Content-Type", "Authorization"]
    max_age       = 3600
  }
}

# ── Outputs ──

output "admin_api_url" {
  value       = aws_lambda_function_url.admin_api.function_url
  description = "Admin dashboard API endpoint"
}

output "admin_api_token" {
  value       = random_password.admin_token.result
  sensitive   = true
  description = "Bearer token for admin API (run: terraform output -raw admin_api_token)"
}
