Pod::Spec.new do |spec|
  spec.name = 'SplitMoriDocumentShare'
  spec.version = '1.0.0'
  spec.summary = 'iOS system sharing for SplitMori settlement documents'
  spec.homepage = 'https://github.com/LennyZhu/SplitMori'
  spec.license = { :type => 'Proprietary' }
  spec.author = 'SplitMori'
  spec.source = { :git => 'https://github.com/LennyZhu/SplitMori.git' }
  spec.platform = :ios, '16.4'
  spec.swift_version = '5.9'
  spec.static_framework = true
  spec.source_files = '*.swift'
  spec.framework = 'UIKit'
  spec.dependency 'ExpoModulesCore'
end
