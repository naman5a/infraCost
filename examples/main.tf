# Example Terraform project matching examples/plan.json.
#
# proj-cost consumes the JSON plan, not .tf files directly. Generate one with:
#   terraform plan -out=tfplan
#   terraform show -json tfplan > plan.json
#   proj-cost breakdown plan.json

provider "google" {
  project = "my-project"
  region  = "asia-south1"
}

# ------------------------------------------------------------- Compute Engine

resource "google_compute_instance" "app" {
  name         = "app-prod"
  machine_type = "e2-standard-4"
  zone         = "asia-south1-a"

  boot_disk {
    initialize_params {
      size = 100
      type = "pd-ssd"
    }
  }

  network_interface {
    network = "default"
  }
}

resource "google_compute_instance" "worker" {
  name         = "worker"
  machine_type = "n2-custom-4-16384"
  zone         = "asia-south1-b"

  boot_disk {
    initialize_params {
      size = 50
      type = "pd-balanced"
    }
  }

  scheduling {
    preemptible       = true
    automatic_restart = false
  }

  network_interface {
    network = "default"
  }
}

resource "google_compute_disk" "data" {
  name = "data-disk"
  size = 500
  type = "pd-balanced"
  zone = "asia-south1-a"
}

resource "google_compute_address" "ingress" {
  name   = "ingress-ip"
  region = "asia-south1"
}

# -------------------------------------------------------------- Cloud Storage

resource "google_storage_bucket" "assets" {
  name          = "assets-bucket"
  location      = "ASIA-SOUTH1"
  storage_class = "STANDARD"
}

# ------------------------------------------------------------------ Cloud SQL

resource "google_sql_database_instance" "main" {
  name             = "main-db"
  database_version = "POSTGRES_15"
  region           = "asia-south1"

  settings {
    tier              = "db-custom-4-16384"
    availability_type = "REGIONAL"
    disk_size         = 100
    disk_type         = "PD_SSD"
  }
}

# ------------------------------------------------------------------------ GKE
# In examples/plan.json these appear under module.gke; inlined here to keep
# the example a single file.

resource "google_container_cluster" "primary" {
  name     = "primary"
  location = "asia-south1"

  remove_default_node_pool = true
  initial_node_count       = 1
}

resource "google_container_node_pool" "workers" {
  name       = "workers"
  location   = "asia-south1"
  cluster    = google_container_cluster.primary.name
  node_count = 3

  node_config {
    machine_type = "e2-standard-2"
    disk_size_gb = 100
    disk_type    = "pd-balanced"
  }
}

# ----------------------------------------------------------- free / unsupported

# Free — proj-cost knows IAM/service accounts cost nothing.
resource "google_service_account" "app" {
  account_id = "app-sa"
}

# Unsupported in v0 — shows up in the report's "unsupported resources" list.
resource "google_pubsub_topic" "events" {
  name = "events"
}
