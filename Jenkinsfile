pipeline {
  agent any

  environment {
    APP_NAME = 'holiday-tracker'
    IMAGE_NAME = 'holiday-tracker:latest'
    APP_DOMAIN = 'holiday-tracker.maisonzaro.com'
    LETSENCRYPT_EMAIL = 'info@maisonzaro.com'
    APP_PORT = '3000'
  }

  options {
    timestamps()
    disableConcurrentBuilds()
  }

  stages {
    stage('Checkout') {
      steps {
        checkout scm
      }
    }

    stage('Build and verify image') {
      steps {
        sh '''#!/bin/sh
          set -eu
          docker build --pull -t "$IMAGE_NAME" .
          docker run --rm "$IMAGE_NAME" node --check src/server.js
        '''
      }
    }

    stage('Deploy') {
      steps {
        sh '''#!/bin/sh
          set -eu
          docker rm -f "$APP_NAME" || true

          docker run -d \\
            --name "$APP_NAME" \\
            --restart unless-stopped \\
            --network proxy \\
            -e VIRTUAL_HOST="$APP_DOMAIN" \\
            -e VIRTUAL_PORT="$APP_PORT" \\
            -e LETSENCRYPT_HOST="$APP_DOMAIN" \\
            -e LETSENCRYPT_EMAIL="$LETSENCRYPT_EMAIL" \\
            -e PORT="$APP_PORT" \\
            "$IMAGE_NAME"
        '''
      }
    }

    stage('Health check') {
      steps {
        sh '''#!/bin/sh
          set -eu
          attempt=1
          while [ "$attempt" -le 10 ]; do
            if docker exec "$APP_NAME" node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"; then
              echo "Health check passed inside container."
              exit 0
            fi
            echo "Waiting for app readiness (attempt $attempt/10)..."
            sleep 3
            attempt=$((attempt + 1))
          done
          echo "Health check failed; recent container logs:"
          docker logs --tail 50 "$APP_NAME" || true
          exit 1
        '''
      }
    }
  }
}
