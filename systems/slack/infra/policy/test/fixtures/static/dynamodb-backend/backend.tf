# REQ-INFRA-008 fixture: a backend that still uses DynamoDB locking.
terraform {
  backend "s3" {
    key            = "dev/ap-northeast-1/network/terraform.tfstate"
    region         = "ap-northeast-1"
    use_lockfile   = true
    dynamodb_table = "terraform-locks"
  }
}
