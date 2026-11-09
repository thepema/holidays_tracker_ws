pipeline {
  agent any

  environment {
    // Configure these values for your VPS before running the pipeline.
    DEPLOY_HOST = 'YOUR_VPS_IP_OR_HOSTNAME'
    DEPLOY_USER = 'deploy'
    DEPLOY_DIR = '/opt/holidays-tracker'
    SERVICE_NAME = 'holidays-tracker'
    APP_PORT = '3000'
    DEPLOY_HOST_KEY = 'vps-deploy-key' // Jenkins SSH private-key credential ID
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

    stage('Verify') {
      steps {
        sh '''#!/bin/sh
          set -eu
          node --version
          npm --version
          npm install
          node --check src/server.js
        '''
      }
    }

    stage('Deploy') {
      steps {
        sshagent(credentials: [env.DEPLOY_HOST_KEY]) {
          sh '''#!/bin/sh
            set -eu
            test "$DEPLOY_HOST" != "YOUR_VPS_IP_OR_HOSTNAME"
            ssh -o BatchMode=yes "$DEPLOY_USER@$DEPLOY_HOST" "mkdir -p '$DEPLOY_DIR'"
            rsync -az --delete \
              --exclude='.git' \
              --exclude='node_modules' \
              ./ "$DEPLOY_USER@$DEPLOY_HOST:$DEPLOY_DIR/"
            ssh -o BatchMode=yes "$DEPLOY_USER@$DEPLOY_HOST" \
              "cd '$DEPLOY_DIR' && npm install --omit=dev && sudo systemctl restart '$SERVICE_NAME'"
          '''
        }
      }
    }

    stage('Health check') {
      steps {
        sh '''#!/bin/sh
          set -eu
          curl --fail --silent --show-error --retry 10 --retry-delay 3 \
            --retry-connrefused https://holiday-tracker.maisonzaro.com/
        '''
      }
    }
  }
}
