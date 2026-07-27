terraform {
  required_version = ">= 1.10.0"

  required_providers {
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 2.38"
    }
  }
}

provider "kubernetes" {
  config_path = var.kubeconfig_path
}

locals {
  workloads = {
    relay-server             = { image = var.relay_image, port = 8080, min = 6, max = 60 }
    control-api              = { image = var.control_image, port = 8080, min = 3, max = 30 }
    admin-api                = { image = var.admin_image, port = 8080, min = 3, max = 12 }
    control-worker-billing   = { image = var.worker_image, port = 9090, min = 3, max = 12 }
    control-worker-push      = { image = var.worker_image, port = 9090, min = 3, max = 30 }
    control-worker-cleanup   = { image = var.worker_image, port = 9090, min = 3, max = 12 }
    control-worker-outbox    = { image = var.worker_image, port = 9090, min = 3, max = 30 }
    control-worker-reconcile = { image = var.worker_image, port = 9090, min = 3, max = 12 }
    review-host              = { image = var.review_host_image, port = 8080, min = 3, max = 15 }
  }
}

resource "kubernetes_namespace_v1" "pocket" {
  metadata {
    name = "pocket-omp-${var.region}"
    labels = {
      "pod-security.kubernetes.io/enforce" = "restricted"
      region                               = var.region
      paired-region                        = var.paired_region
    }
  }
}

resource "kubernetes_service_account_v1" "workload" {
  for_each = local.workloads

  metadata {
    name      = each.key
    namespace = kubernetes_namespace_v1.pocket.metadata[0].name
  }

  automount_service_account_token = false
}

resource "kubernetes_deployment_v1" "workload" {
  for_each = local.workloads

  metadata {
    name      = each.key
    namespace = kubernetes_namespace_v1.pocket.metadata[0].name
    labels    = { app = each.key }
  }

  spec {
    replicas = each.value.min

    selector {
      match_labels = { app = each.key }
    }

    template {
      metadata {
        labels = { app = each.key }
      }

      spec {
        service_account_name            = kubernetes_service_account_v1.workload[each.key].metadata[0].name
        automount_service_account_token = false

        topology_spread_constraint {
          max_skew           = 1
          topology_key       = "topology.kubernetes.io/zone"
          when_unsatisfiable = "DoNotSchedule"

          label_selector {
            match_labels = { app = each.key }
          }
        }

        container {
          name              = each.key
          image             = each.value.image
          image_pull_policy = "IfNotPresent"

          port {
            name           = "http"
            container_port = each.value.port
          }

          env {
            name  = "POCKET_REGION"
            value = var.region
          }

          env {
            name  = "POCKET_PAIRED_REGION"
            value = var.paired_region
          }

          env_from {
            secret_ref {
              name = var.runtime_secret_name
            }
          }

          resources {
            requests = { cpu = "250m", memory = "256Mi" }
            limits   = { cpu = "2", memory = "1Gi" }
          }

          security_context {
            allow_privilege_escalation = false
            read_only_root_filesystem  = true
            run_as_non_root            = true

            capabilities {
              drop = ["ALL"]
            }

            seccomp_profile {
              type = "RuntimeDefault"
            }
          }

          readiness_probe {
            http_get {
              path = "/health/ready"
              port = "http"
            }
            initial_delay_seconds = 3
            period_seconds        = 5
            failure_threshold     = 3
          }

          liveness_probe {
            http_get {
              path = "/health/live"
              port = "http"
            }
            initial_delay_seconds = 10
            period_seconds        = 10
            failure_threshold     = 3
          }
        }
      }
    }
  }
}

resource "kubernetes_service_v1" "workload" {
  for_each = local.workloads

  metadata {
    name      = each.key
    namespace = kubernetes_namespace_v1.pocket.metadata[0].name
  }

  spec {
    selector = { app = each.key }

    port {
      name        = "http"
      port        = each.value.port
      target_port = "http"
    }
  }
}

resource "kubernetes_pod_disruption_budget_v1" "workload" {
  for_each = local.workloads

  metadata {
    name      = each.key
    namespace = kubernetes_namespace_v1.pocket.metadata[0].name
  }

  spec {
    min_available = "67%"

    selector {
      match_labels = { app = each.key }
    }
  }
}

resource "kubernetes_horizontal_pod_autoscaler_v2" "workload" {
  for_each = local.workloads

  metadata {
    name      = each.key
    namespace = kubernetes_namespace_v1.pocket.metadata[0].name
  }

  spec {
    min_replicas = each.value.min
    max_replicas = each.value.max

    scale_target_ref {
      api_version = "apps/v1"
      kind        = "Deployment"
      name        = each.key
    }

    metric {
      type = "Resource"
      resource {
        name = "cpu"
        target {
          type                = "Utilization"
          average_utilization = 65
        }
      }
    }

    behavior {
      scale_down {
        stabilization_window_seconds = 300
        policy {
          type           = "Percent"
          value          = 20
          period_seconds = 60
        }
      }
      scale_up {
        stabilization_window_seconds = 30
        policy {
          type           = "Percent"
          value          = 100
          period_seconds = 30
        }
      }
    }
  }
}

resource "kubernetes_network_policy_v1" "default_deny" {
  metadata {
    name      = "default-deny"
    namespace = kubernetes_namespace_v1.pocket.metadata[0].name
  }

  spec {
    pod_selector {}
    policy_types = ["Ingress", "Egress"]
  }
}

resource "kubernetes_network_policy_v1" "workload" {
  metadata {
    name      = "workload-traffic"
    namespace = kubernetes_namespace_v1.pocket.metadata[0].name
  }

  spec {
    pod_selector {}

    ingress {
      from {
        namespace_selector {
          match_labels = {
            "kubernetes.io/metadata.name" = kubernetes_namespace_v1.pocket.metadata[0].name
          }
        }
      }
    }

    egress {
      to {
        namespace_selector {
          match_labels = { "kubernetes.io/metadata.name" = "kube-system" }
        }
      }
      ports {
        port     = "53"
        protocol = "UDP"
      }
      ports {
        port     = "53"
        protocol = "TCP"
      }
    }

    egress {
      to {
        ip_block {
          cidr = var.private_egress_cidr
        }
      }
    }

    policy_types = ["Ingress", "Egress"]
  }
}
