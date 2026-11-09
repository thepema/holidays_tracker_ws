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

    stage('Build image') {
      steps {
        sh '''#!/bin/sh
          set -eu
          docker build --pull -t "$IMAGE_NAME" .
        '''
      }
    }

    stage('Deploy') {
      steps {
        sh '''#!/bin/sh
          set -eu
          docker rm -f "$APP_NAME" || true

          docker run -d \
            --name "$APP_NAME" \
            --restart unless-stopped \
            --network proxy \
            -e VIRTUAL_HOST="$APP_DOMAIN" \
            -e VIRTUAL_PORT="$APP_PORT" \
            -e LETSENCRYPT_HOST="$APP_DOMAIN" \
            -e LETSENCRYPT_EMAIL="$LETSENCRYPT_EMAIL" \
            -e PORT="$APP_PORT" \
            "$IMAGE_NAME"
        '''
      }
    }

    stage('Health check') {
      steps {
        sh '''#!/bin/sh
          set -eu
          curl --fail --silent --show-error --retry 10 --retry-delay 3 \
            --retry-connrefused "https://$APP_DOMAIN/"
        '''
      }
    }
  }
}
