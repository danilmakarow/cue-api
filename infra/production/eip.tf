resource "aws_eip" "app" {
  domain = "vpc"
  tags   = { Name = "${var.project}-api" }
}

resource "aws_eip_association" "app" {
  instance_id   = aws_instance.app.id
  allocation_id = aws_eip.app.id
}

output "elastic_ip" {
  description = "Stable public IP — the Phase 3 DNS record will point here."
  value       = aws_eip.app.public_ip
}