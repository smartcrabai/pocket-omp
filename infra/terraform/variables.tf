variable "kubeconfig_path" {
  type    = string
  default = "~/.kube/config"
}

variable "region" {
  type = string

  validation {
    condition     = length(var.region) > 0
    error_message = "region is required"
  }
}

variable "paired_region" {
  type = string

  validation {
    condition     = var.paired_region != var.region
    error_message = "paired_region must differ from region"
  }
}

variable "relay_image" {
  type = string
}

variable "control_image" {
  type = string
}

variable "admin_image" {
  type = string
}

variable "worker_image" {
  type = string
}

variable "review_host_image" {
  type = string
}

variable "runtime_secret_name" {
  type    = string
  default = "pocket-omp-runtime"
}

variable "private_egress_cidr" {
  type        = string
  description = "Private CIDR containing managed PostgreSQL, Redis, and object storage endpoints."
}
