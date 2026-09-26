# REQ-INFRA-007 fixture: the Osaka root points at the Tokyo state bucket.
terraform {
  backend "s3" {
    bucket       = "slack-tfstate-333333333333-ap-northeast-1"
    key          = "prod/ap-northeast-3/network/terraform.tfstate"
    region       = "ap-northeast-1"
    use_lockfile = true
  }
}
