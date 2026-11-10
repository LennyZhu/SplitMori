Pod::Spec.new do |spec|
  spec.name = 'SplitMoriStoreKit'
  spec.version = '1.0.0'
  spec.summary = 'StoreKit 2 bridge for SplitMori Lifetime Pro'
  spec.homepage = 'https://github.com/LennyZhu/SplitMori'
  spec.license = { :type => 'Proprietary' }
  spec.author = 'SplitMori'
  spec.source = { :git => 'https://github.com/LennyZhu/SplitMori.git' }
  spec.platform = :ios, '16.4'
  spec.swift_version = '5.9'
  spec.static_framework = true
  spec.source_files = '*.swift'
  spec.framework = 'StoreKit'
  spec.dependency 'ExpoModulesCore'
end
