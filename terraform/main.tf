terraform {
  required_version = ">= 1.5"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  backend "s3" {
    bucket = "geos-ai-terraform-state"
    key    = "landing-page/terraform.tfstate"
    region = "us-east-1"
  }
}

provider "aws" {
  region = "us-east-1"
}

variable "github_token" {
  description = "GitHub PAT for reading commit info from private repos"
  type        = string
  default     = ""
  sensitive   = true
}

# ── Import existing resources (already created manually) ──

# S3 bucket — already exists, just import it
import {
  to = aws_s3_bucket.site
  id = "www.geos-ai.com"
}

resource "aws_s3_bucket" "site" {
  bucket = "www.geos-ai.com"
}

resource "aws_s3_bucket_website_configuration" "site" {
  bucket = aws_s3_bucket.site.id

  index_document {
    suffix = "index.html"
  }

  error_document {
    key = "index.html"
  }
}

resource "aws_s3_bucket_public_access_block" "site" {
  bucket = aws_s3_bucket.site.id

  block_public_acls       = false
  block_public_policy     = false
  ignore_public_acls      = false
  restrict_public_buckets = false
}

resource "aws_s3_bucket_policy" "site" {
  bucket = aws_s3_bucket.site.id
  depends_on = [aws_s3_bucket_public_access_block.site]

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "PublicReadGetObject"
        Effect    = "Allow"
        Principal = "*"
        Action    = "s3:GetObject"
        Resource  = "${aws_s3_bucket.site.arn}/*"
      }
    ]
  })
}

# ── Sync site files to S3 ──

locals {
  site_dir = "${path.module}/.."

  # All files to upload (static site root)
  site_files = fileset(local.site_dir, "**/*.{html,css,js,json,png,jpg,jpeg,avif,svg,ico,webp,txt,xml,md,woff,woff2}")

  content_types = {
    "html"  = "text/html"
    "css"   = "text/css"
    "js"    = "application/javascript"
    "json"  = "application/json"
    "png"   = "image/png"
    "jpg"   = "image/jpeg"
    "jpeg"  = "image/jpeg"
    "avif"  = "image/avif"
    "svg"   = "image/svg+xml"
    "ico"   = "image/x-icon"
    "webp"  = "image/webp"
    "txt"   = "text/plain"
    "xml"   = "application/xml"
    "md"    = "text/markdown"
    "woff"  = "font/woff"
    "woff2" = "font/woff2"
  }
}

resource "aws_s3_object" "site_files" {
  for_each = {
    for f in local.site_files :
    f => f
    if !startswith(f, "terraform/") && !startswith(f, ".github/") && !startswith(f, ".git/") && !startswith(f, "node_modules/")
  }

  bucket       = aws_s3_bucket.site.id
  key          = each.value
  source       = "${local.site_dir}/${each.value}"
  etag         = filemd5("${local.site_dir}/${each.value}")
  content_type = lookup(local.content_types, regex("\\.[^.]+$", each.value) == "" ? "html" : substr(regex("\\.[^.]+$", each.value), 1, -1), "application/octet-stream")
}

# ── CloudFront invalidation after deploy ──

resource "terraform_data" "invalidate_cache" {
  triggers_replace = [
    sha1(join(",", [for f in aws_s3_object.site_files : f.etag]))
  ]

  provisioner "local-exec" {
    command = "aws cloudfront create-invalidation --distribution-id E2C37J0OR4UFLY --paths '/*'"
  }
}

# ── Outputs ──

output "bucket_name" {
  value = aws_s3_bucket.site.id
}

output "website_url" {
  value = "https://www.geos-ai.com"
}

output "files_deployed" {
  value = length(aws_s3_object.site_files)
}
