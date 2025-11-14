kubectl exec -it -n minio deploy/minio -- sh

mc alias set local http://localhost:9000 root AndresMinio761995!

mc admin user list local --disable-pager

mc admin user add local sender-user sender-secret-123

mc admin policy attach local readwrite --user sender-user

mc admin user info local sender-user

mc mb local/bucket-sender --ignore-existing

mc ls local

