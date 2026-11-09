pipeline {
  agent any

  environment {
    LETSENCRYPT_EMAIL = 'info@maisonzaro.com'
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

    stage('Configure deployment target') {
      steps {
        script {
          def branch = (env.BRANCH_NAME ?: env.GIT_BRANCH ?: '')
            .replaceFirst(/^origin\//, '')
            .replaceFirst(/^refs\/heads\//, '')
            .replaceFirst(/^\*\//, '')

          switch (branch) {
            case ['development', 'develop']:
              env.APP_NAME = 'holiday-tracker-api-dev'
              env.APP_DOMAIN = 'holiday-tracker-api.dev.maisonzaro.com'
              env.APP_PORT = '3001'
              env.IMAGE_NAME = "holiday-tracker-api:dev-${env.BUILD_NUMBER}"
              break
            case 'main':
              env.APP_NAME = 'holiday-tracker-api'
              env.APP_DOMAIN = 'holiday-tracker-api.maisonzaro.com'
              env.APP_PORT = '3000'
              env.IMAGE_NAME = "holiday-tracker-api:prod-${env.BUILD_NUMBER}"
              break
            default:
              env.IMAGE_NAME = "holiday-tracker-api:${branch.replaceAll(/[^a-zA-Z0-9_.-]/, '-')}-${env.BUILD_NUMBER}"
              echo "Branch '${branch}' is not configured for deployment; build and verification only."
          }

          def deployEnabled = ['holiday-tracker-api-dev', 'holiday-tracker-api'].contains(env.APP_NAME)
          echo "Branch '${branch}': deploy=${deployEnabled}, domain=${env.APP_DOMAIN ?: 'n/a'}, port=${env.APP_PORT ?: 'n/a'}"
        }
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
      when {
        expression { ['holiday-tracker-api-dev', 'holiday-tracker-api'].contains(env.APP_NAME) }
      }
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
      when {
        expression { ['holiday-tracker-api-dev', 'holiday-tracker-api'].contains(env.APP_NAME) }
      }
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
