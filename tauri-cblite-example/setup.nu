def couchbase_sbx_build_image [] {
    docker build -t cbm/tauri-sandbox .
}

def couchbase_sbx_start [] {
 if ( couchbase_sbx_image_exist ) {
    couchbase_sbx_run
  } else {
    couchbase_sbx_build_image
    couchbase_sbx_run
  }
}

def retry-command [cmd: closure, attempts=15, sleep=5sec] {
  for i in 1..$attempts {
    let result = (do $cmd | complete)
    if $result.exit_code == 0 {
      return $result
    }
    print $"  ⏳ Attempt ($i) failed, retrying..."
    sleep $sleep
  }
  error make $"Command failed after ($attempts) attempts"
}

def couchbase_sbx_run [] {
   ( docker run --name sbx
    -d
    --rm
    -p 8091-8094:8091-8094
    -p 11210:11210
    -p 4984-4986:4984-4986
     cbm/tauri-sandbox couchbase-server )

   print "▶ Waiting for Couchbase Server..."
   retry-command {|| curl -s http://127.0.0.1:8091/ui/index.html }
   print "✅ Couchbase Server is up"

   print "▶ Deleting travel-sample bucket..."
   retry-command {|| curl -s -X DELETE http://127.0.0.1:8091/pools/default/buckets/travel-sample -u Administrator:password }
   print "✅ travel-sample bucket removed"

   print "▶ Waiting for deletion to complete..."
   sleep 10sec

   print "▶ Creating notes bucket..."
   retry-command {|| curl -s -X POST "http://127.0.0.1:8091/pools/default/buckets" -u Administrator:password -d "name=notes" -d "bucketType=couchbase" -d "ramQuotaMB=100" -d "flushEnabled=1" }
   print "✅ notes bucket created"

   print "▶ Creating auth bucket..."
   retry-command {|| curl -s -X POST "http://127.0.0.1:8091/pools/default/buckets" -u Administrator:password -d "name=auth" -d "bucketType=couchbase" -d "ramQuotaMB=64" -d "flushEnabled=1" }
   print "✅ auth bucket created"

   print "▶ Waiting for buckets to become ready..."
   retry-command {|| curl -s http://127.0.0.1:8091/pools/default/buckets/notes -u Administrator:password }
   print "✅ buckets are ready"

 



   print "▶ Creating test user..."
   retry-command {|| curl -s -X PUT "http://127.0.0.1:4985/notes/_user/testuser" -u Administrator:password -H "Content-Type: application/json" -d '{"password":"testpass","admin_channels":["*"]}' }
   print "✅ test user created"

   print "✅ Done! All services ready."
}

def couchbase_sbx_stop [] {
    docker stop sbx
}

def couchbase_sbx_is_running [] {
    docker ps --format json | from json | get --optional Names | where { |x| $x | is-not-empty } |  where { |x|  "sbx" in $x } | is-not-empty
}

def couchbase_sbx_image_exist [] {
 docker images --format '{{.Repository}}:{{.Tag}}' | lines | where { |x| $x == "cbm/tauri-sandbox:latest" } | is-not-empty
}